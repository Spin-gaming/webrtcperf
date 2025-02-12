/* global webrtcperf, log, sleep */

const applyOverride = (constraints, override) => {
  if (override) {
    if (override.video !== undefined) {
      if (override.video instanceof Object) {
        if (!(constraints.video instanceof Object)) {
          constraints.video = {}
        }
        Object.assign(constraints.video, override.video)
      } else {
        constraints.video = override.video
      }
    }
    if (override.audio !== undefined) {
      if (override.audio instanceof Object) {
        if (!(constraints.audio instanceof Object)) {
          constraints.audio = {}
        }
        Object.assign(constraints.audio, override.audio)
      } else {
        constraints.audio = override.audio
      }
    }
    log(`applyOverride result:`, constraints)
  }
  // Force audio sample rate to 48kHz.
  if (constraints.audio) {
    if (!(constraints.audio instanceof Object)) {
      constraints.audio = {}
    }
    constraints.audio.sampleRate = 48000
  }
}

/**
 * overrideGetUserMedia
 * @param {*} constraints
 */
function overrideGetUserMedia(constraints) {
  applyOverride(constraints, window.GET_USER_MEDIA_OVERRIDE)
}

/**
 * overrideGetDisplayMedia
 * @param {*} constraints
 */
function overrideGetDisplayMedia(constraints) {
  applyOverride(constraints, window.GET_DISPLAY_MEDIA_OVERRIDE)
}

async function applyGetDisplayMediaCrop(mediaStream) {
  if (!window.GET_DISPLAY_MEDIA_CROP) {
    return
  }
  const element = document.querySelector(window.GET_DISPLAY_MEDIA_CROP)
  const videoTrack = mediaStream.getVideoTracks()[0]
  if (element && videoTrack) {
    if ('RestrictionTarget' in window && 'fromElement' in window.RestrictionTarget) {
      log(`applyGetDisplayMediaCrop with RestrictionTarget to "${window.GET_DISPLAY_MEDIA_CROP}"`)
      const restrictionTarget = await window.RestrictionTarget.fromElement(element)
      await videoTrack.restrictTo(restrictionTarget)
    } else {
      log(`applyGetDisplayMediaCrop to "${window.GET_DISPLAY_MEDIA_CROP}"`)
      element.style.zIndex = 99999
      const cropTarget = await window.CropTarget.fromElement(element)
      await videoTrack.cropTo(cropTarget)
    }
  }
}

webrtcperf.audioTracks = new Set()
webrtcperf.videoTracks = new Set()

/**
 * getActiveAudioTracks
 * @return {*} The active audio tracks array.
 */
window.getActiveAudioTracks = () => {
  for (const track of webrtcperf.audioTracks.values()) {
    if (track.readyState === 'ended') {
      webrtcperf.audioTracks.delete(track)
    }
  }
  return [...webrtcperf.audioTracks.values()]
}

/**
 * getActiveVideoTracks
 * @return {*} The active video tracks array.
 */
window.getActiveVideoTracks = () => {
  for (const track of webrtcperf.videoTracks.values()) {
    if (track.readyState === 'ended') {
      webrtcperf.videoTracks.delete(track)
    }
  }
  return [...webrtcperf.videoTracks.values()]
}

/**
 * It collects MediaTracks from MediaStream.
 * @param {MediaStream} mediaStream
 */
function collectMediaTracks(mediaStream, onEnded = null) {
  const audioTracks = mediaStream.getAudioTracks()
  if (audioTracks.length) {
    const track = audioTracks[0]
    /* log(`MediaStream new audio track ${track.id}`); */
    track.addEventListener('ended', () => webrtcperf.audioTracks.delete(track))
    webrtcperf.audioTracks.add(track)
  }
  const videoTracks = mediaStream.getVideoTracks()
  if (videoTracks.length) {
    const track = videoTracks[0]
    /* const settings = track.getSettings() */
    /* log(`MediaStream new video track ${track.id} ${
      settings.width}x${settings.height} ${settings.frameRate}fps`); */
    track.addEventListener('ended', () => {
      webrtcperf.videoTracks.delete(track)
      if (onEnded) {
        onEnded(track)
      }
    })
    webrtcperf.videoTracks.add(track)
  }
  // Log applyConstraints calls.
  mediaStream.getTracks().forEach(track => {
    const applyConstraintsNative = track.applyConstraints.bind(track)
    track.applyConstraints = constraints => {
      log(`applyConstraints ${track.id} (${track.kind})`, { track, constraints })
      if (window.overrideTrackApplyConstraints) {
        constraints = window.overrideTrackApplyConstraints(track, constraints)
      }
      return applyConstraintsNative(constraints)
    }
  })
}

// Overrides.
if (navigator.getUserMedia) {
  const nativeGetUserMedia = navigator.getUserMedia.bind(navigator)
  navigator.getUserMedia = async function (constraints, ...args) {
    log(`getUserMedia:`, constraints)
    try {
      overrideGetUserMedia(constraints, ...args)
    } catch (err) {
      log(`overrideGetUserMedia error:`, err)
    }
    return nativeGetUserMedia(constraints, ...args)
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async function (constraints, ...args) {
    log(`getUserMedia:`, JSON.stringify(constraints, null, 2))
    try {
      overrideGetUserMedia(constraints)
    } catch (err) {
      log(`overrideGetUserMedia error:`, err)
    }
    if (window.PARAMS?.getUserMediaWaitTime > 0) {
      await sleep(window.PARAMS?.getUserMediaWaitTime)
    }
    let mediaStream = await nativeGetUserMedia(constraints, ...args)
    if (window.overrideGetUserMediaStream !== undefined) {
      try {
        mediaStream = await window.overrideGetUserMediaStream(mediaStream)
      } catch (err) {
        log(`overrideGetUserMediaStream error:`, err)
      }
    }
    try {
      collectMediaTracks(mediaStream)
    } catch (err) {
      log(`collectMediaTracks error:`, err)
    }

    if (webrtcperf.enabledForSession(window.PARAMS?.timestampWatermarkAudio)) {
      mediaStream = webrtcperf.applyAudioTimestampWatermark(mediaStream)
    }

    if (webrtcperf.enabledForSession(window.PARAMS?.timestampWatermarkVideo)) {
      mediaStream = webrtcperf.applyVideoTimestampWatermark(mediaStream)
    }

    return mediaStream
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
  const nativeGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getDisplayMedia = async function (constraints, ...args) {
    log(`getDisplayMedia:`, JSON.stringify(constraints, null, 2))
    let stopFakeScreenshare = null
    if (window.PARAMS?.fakeScreenshare) {
      stopFakeScreenshare = await webrtcperf.setupFakeScreenshare(window.PARAMS?.fakeScreenshare)
    }
    overrideGetDisplayMedia(constraints)
    if (window.PARAMS?.getDisplayMediaWaitTime > 0) {
      await sleep(window.PARAMS?.getDisplayMediaWaitTime)
    }
    let mediaStream = await nativeGetDisplayMedia(constraints, ...args)
    await applyGetDisplayMediaCrop(mediaStream)
    if (window.overrideGetDisplayMediaStream !== undefined) {
      try {
        mediaStream = await window.overrideGetDisplayMediaStream(mediaStream)
      } catch (err) {
        log(`overrideGetDisplayMediaStream error:`, err)
      }
    }
    collectMediaTracks(mediaStream, () => {
      if (stopFakeScreenshare) stopFakeScreenshare()
    })
    return mediaStream
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.setCaptureHandleConfig) {
  const setCaptureHandleConfig = navigator.mediaDevices.setCaptureHandleConfig.bind(navigator.mediaDevices)
  navigator.mediaDevices.setCaptureHandleConfig = config => {
    log('setCaptureHandleConfig', config)
    return setCaptureHandleConfig(config)
  }
}
