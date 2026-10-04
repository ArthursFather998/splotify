import Foundation
import Capacitor
import AVFoundation
import MediaPlayer

/**
 * SplotifyAudio — native audio output for the Splotify iOS shell.
 *
 * The web app stays the brain (queue, shuffle, repeat, likes, play counts).
 * This plugin is just the speaker: AVPlayer playback with a real
 * MPRemoteCommandCenter setup — previous / play-pause / next on the lock
 * screen and Control Center, and explicitly NO +/- interval skip buttons.
 */
@objc(SplotifyAudio)
public class SplotifyAudio: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SplotifyAudio"
    public let jsName = "SplotifyAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekTo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMuted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPosition", returnType: CAPPluginReturnPromise)
    ]

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var isMuted = false
    private var volume: Float = 1.0

    override public func load() {
        configureAudioSession()
        configureRemoteCommands()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
    }

    deinit {
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
        }
        NotificationCenter.default.removeObserver(self)
    }

    private func documentsURL() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("[SplotifyAudio] audio session error: \(error)")
        }
    }

    // MARK: - Remote commands: prev / play-pause / next only.

    private func configureRemoteCommands() {
        let cc = MPRemoteCommandCenter.shared()

        cc.playCommand.isEnabled = true
        cc.playCommand.addTarget { [weak self] _ in
            self?.player?.play()
            self?.updatePlaybackRate(1)
            self?.notifyListeners("remotePlay", data: [:])
            return .success
        }

        cc.pauseCommand.isEnabled = true
        cc.pauseCommand.addTarget { [weak self] _ in
            self?.player?.pause()
            self?.updatePlaybackRate(0)
            self?.notifyListeners("remotePause", data: [:])
            return .success
        }

        cc.previousTrackCommand.isEnabled = true
        cc.previousTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remotePrev", data: [:])
            return .success
        }

        cc.nextTrackCommand.isEnabled = true
        cc.nextTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remoteNext", data: [:])
            return .success
        }

        cc.changePlaybackPositionCommand.isEnabled = true
        cc.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek(to: e.positionTime)
            return .success
        }

        // Explicitly disabled: these are the +/- interval buttons iOS shows
        // INSTEAD OF previous/next. They must never be enabled.
        cc.skipForwardCommand.isEnabled = false
        cc.skipBackwardCommand.isEnabled = false
        cc.seekForwardCommand.isEnabled = false
        cc.seekBackwardCommand.isEnabled = false
    }

    // MARK: - Plugin API

    @objc func setTrack(_ call: CAPPluginCall) {
        guard let relPath = call.getString("path"), !relPath.isEmpty else {
            call.reject("missing path")
            return
        }
        let title = call.getString("title") ?? "Unknown"
        let artist = call.getString("artist") ?? "Unknown"
        let album = call.getString("album") ?? ""
        let durationHint = call.getDouble("duration") ?? 0
        let artworkRel = call.getString("artworkPath") ?? ""

        let fileURL = documentsURL().appendingPathComponent(relPath)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            call.reject("audio file not found")
            return
        }

        NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: nil)
        let item = AVPlayerItem(url: fileURL)
        if player == nil {
            player = AVPlayer()
            addTimeObserver()
        }
        player?.replaceCurrentItem(with: item)
        applyVolume()

        var artwork: MPMediaItemArtwork?
        if !artworkRel.isEmpty {
            let artURL = documentsURL().appendingPathComponent(artworkRel)
            if let img = UIImage(contentsOfFile: artURL.path) {
                artwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(itemDidEnd(_:)),
            name: .AVPlayerItemDidPlayToEndTime,
            object: item
        )

        let assetDur = item.asset.duration.seconds
        let realDur = assetDur.isFinite && assetDur > 0 ? assetDur : durationHint
        setNowPlaying(title: title, artist: artist, album: album, duration: realDur, artwork: artwork)
        call.resolve(["duration": realDur])
    }

    @objc func play(_ call: CAPPluginCall) {
        configureAudioSession()
        player?.play()
        updatePlaybackRate(1)
        call.resolve()
    }

    @objc func pause(_ call: CAPPluginCall) {
        player?.pause()
        updatePlaybackRate(0)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        call.resolve()
    }

    @objc func seekTo(_ call: CAPPluginCall) {
        seek(to: call.getDouble("pos") ?? 0)
        call.resolve()
    }

    @objc func setMuted(_ call: CAPPluginCall) {
        isMuted = call.getBool("muted") ?? false
        volume = Float(call.getDouble("volume") ?? 1.0)
        applyVolume()
        call.resolve()
    }

    @objc func getPosition(_ call: CAPPluginCall) {
        let pos = player?.currentTime().seconds ?? 0
        let dur = player?.currentItem?.duration.seconds ?? 0
        call.resolve([
            "pos": pos.isFinite ? pos : 0,
            "dur": dur.isFinite ? dur : 0
        ])
    }

    // MARK: - Internals

    private func applyVolume() {
        player?.volume = isMuted ? 0 : volume
    }

    private func seek(to pos: Double) {
        guard let p = player else { return }
        p.seek(to: CMTime(seconds: pos, preferredTimescale: 600),
               toleranceBefore: .zero, toleranceAfter: .zero)
        updateElapsed(pos)
    }

    private func addTimeObserver() {
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserver = player?.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            guard let self = self else { return }
            let pos = time.seconds
            let dur = self.player?.currentItem?.duration.seconds ?? 0
            self.notifyListeners("position", data: [
                "pos": pos.isFinite ? pos : 0,
                "dur": dur.isFinite ? dur : 0
            ])
            self.updateElapsed(pos.isFinite ? pos : 0)
        }
    }

    private func setNowPlaying(title: String, artist: String, album: String, duration: Double, artwork: MPMediaItemArtwork?) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyAlbumTitle: album,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: 0,
            MPNowPlayingInfoPropertyPlaybackRate: 0
        ]
        if let artwork = artwork {
            info[MPMediaItemPropertyArtwork] = artwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func updatePlaybackRate(_ rate: Float) {
        guard var info = MPNowPlayingInfoCenter.default().nowPlayingInfo else { return }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player?.currentTime().seconds ?? 0
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func updateElapsed(_ pos: Double) {
        guard var info = MPNowPlayingInfoCenter.default().nowPlayingInfo else { return }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = pos
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    @objc private func itemDidEnd(_ notification: Notification) {
        updatePlaybackRate(0)
        notifyListeners("trackEnded", data: [:])
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw),
              type == .began else { return }
        player?.pause()
        updatePlaybackRate(0)
        notifyListeners("interrupted", data: [:])
    }
}
