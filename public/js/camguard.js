// Camera guard for proctored quizzes: watches the device's front camera and
// tells the quiz page to blur itself while a phone is held up (someone trying
// to photograph the screen), nobody is in front of the screen, someone else is
// looking, or the camera stops.
//
// Everything runs on the member's device: TensorFlow.js + the COCO-SSD object
// detector (it knows "cell phone" and "person"). No picture or video leaves
// the device. The library and model are served by getxmatch itself
// (/vendor/*, /models/coco-ssd/*) and only load when a quiz is started.
//
// A web page can only see what the camera sees: a phone held low or off to
// the side, out of the camera's view, can't be caught.
(function () {
  'use strict';

  var MODEL_URL = '/models/coco-ssd/model.json';
  var PHONE_SCORE = 0.45; // confidence for "cell phone"
  var PERSON_SCORE = 0.5; // confidence for "person"
  var PHONE_FRAMES = 2; // consecutive frames with a phone before blurring
  var OTHERS_FRAMES = 2; // consecutive frames with 2+ people before blurring
  var CLEAR_MS = 2000; // a phone/second person must be gone this long to unblur
  var AWAY_MS = 3000; // nobody in view this long blurs

  var modelPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Library + model, loaded once per page (the browser caches the files).
  function loadModel() {
    if (!modelPromise) {
      // tf.min.js assigns the global `regeneratorRuntime` and, if that throws,
      // falls back to Function(...) — which the site's CSP (no unsafe-eval)
      // forbids. Declaring the global first keeps it on the plain assignment.
      if (!('regeneratorRuntime' in window)) window.regeneratorRuntime = undefined;
      modelPromise = (window.tf ? Promise.resolve() : loadScript('/vendor/tf.min.js'))
        .then(function () { return window.cocoSsd ? null : loadScript('/vendor/coco-ssd.min.js'); })
        .then(function () { return window.tf.ready(); })
        .then(function () { return window.cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: MODEL_URL }); });
      modelPromise.catch(function () { modelPromise = null; });
    }
    return modelPromise;
  }

  function camError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(camError('unsupported', 'This browser can’t use the camera. Open the quiz in an up-to-date Chrome, Edge, Firefox or Safari.'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    }).catch(function (err) {
      var n = err && err.name;
      if (n === 'NotAllowedError' || n === 'SecurityError') {
        throw camError('denied', 'Camera access was blocked. Allow the camera for this site (the camera icon in the address bar), then try again.');
      }
      if (n === 'NotFoundError' || n === 'OverconstrainedError') {
        throw camError('nocamera', 'No camera was found. This quiz needs a working front camera or webcam.');
      }
      if (n === 'NotReadableError' || n === 'AbortError') {
        throw camError('busy', 'Your camera is being used by another app. Close it, then try again.');
      }
      throw camError('camera', 'Could not turn on the camera. Please try again.');
    });
  }

  // opts.video: <video> element that shows the camera (also used for detection)
  // opts.onChange(state): state is null when all clear, or
  //   { reason: 'phone' | 'others' | 'away' | 'camera', message: string }
  function create(opts) {
    var video = opts.video;
    var onChange = opts.onChange || function () {};
    var stream = null;
    var model = null;
    var running = false;
    var timer = null;
    var current = null; // current block reason

    var phoneHits = 0;
    var othersHits = 0;
    var lastPhoneAt = 0;
    var lastOthersAt = 0;
    var lastPersonAt = 0;
    var cameraLost = false;

    var MESSAGES = {
      camera: 'Your camera turned off. The quiz stays hidden until it’s back on.',
      phone: 'A phone was detected in front of the screen. Put it away to see the quiz again.',
      others: 'Someone else is in view. The quiz stays hidden while another person is looking.',
      away: 'We can’t see you. Sit in front of the camera (and don’t cover it) to see the quiz again.',
    };

    function setState(reason) {
      if (reason === current) return;
      current = reason;
      onChange(reason ? { reason: reason, message: MESSAGES[reason] } : null);
    }

    function evaluate() {
      var now = Date.now();
      if (cameraLost) return setState('camera');
      if (phoneHits >= PHONE_FRAMES || (current === 'phone' && now - lastPhoneAt < CLEAR_MS)) return setState('phone');
      if (othersHits >= OTHERS_FRAMES || (current === 'others' && now - lastOthersAt < CLEAR_MS)) return setState('others');
      if (now - lastPersonAt > AWAY_MS) return setState('away');
      setState(null);
    }

    function watchTracks() {
      stream.getVideoTracks().forEach(function (t) {
        t.addEventListener('ended', function () { cameraLost = true; if (running) evaluate(); });
        t.addEventListener('mute', function () { cameraLost = true; if (running) evaluate(); });
        t.addEventListener('unmute', function () { cameraLost = false; if (running) evaluate(); });
      });
    }

    function attach(s) {
      stream = s;
      cameraLost = false;
      video.muted = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.srcObject = s;
      watchTracks();
      var p = video.play();
      return Promise.resolve(p).catch(function () {}).then(function () {
        if (video.readyState >= 2 && video.videoWidth) return;
        return new Promise(function (resolve) {
          var done = function () { video.removeEventListener('loadeddata', done); resolve(); };
          video.addEventListener('loadeddata', done);
          setTimeout(done, 4000);
        });
      });
    }

    function releaseCamera() {
      if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (_e) {} });
      stream = null;
      video.srcObject = null;
    }

    function cameraAlive() {
      return !!stream && stream.getVideoTracks().some(function (t) { return t.readyState === 'live'; });
    }

    // Turn the camera on and load the detector. Resolves when ready to start.
    function prepare() {
      var cam = cameraAlive() ? Promise.resolve() : openCamera().then(attach);
      return Promise.all([cam, loadModel().catch(function () {
        throw camError('model', 'The camera check couldn’t load. Check your connection and try again.');
      })]).then(function (r) { model = r[1]; });
    }

    function scheduleNext(ms) {
      if (!running) return;
      clearTimeout(timer);
      timer = setTimeout(step, ms);
    }

    function step() {
      if (!running) return;
      if (!cameraAlive()) { cameraLost = true; evaluate(); scheduleNext(1000); return; }
      if (document.hidden || !video.videoWidth || video.readyState < 2) { scheduleNext(500); return; }
      var t0 = performance.now();
      model.detect(video, 10, 0.3).then(function (dets) {
        if (!running) return;
        var now = Date.now();
        var phone = false;
        var people = 0;
        dets.forEach(function (d) {
          if (d.class === 'cell phone' && d.score >= PHONE_SCORE) phone = true;
          else if (d.class === 'person' && d.score >= PERSON_SCORE) people++;
        });
        if (phone) { phoneHits++; lastPhoneAt = now; } else phoneHits = 0;
        if (people >= 2) { othersHits++; lastOthersAt = now; } else othersHits = 0;
        if (people >= 1) lastPersonAt = now;
        cameraLost = false;
        evaluate();
        // Slower devices check less often so the quiz stays responsive.
        var took = performance.now() - t0;
        scheduleNext(Math.min(1500, Math.max(350, took * 1.5)));
      }).catch(function () { scheduleNext(1000); });
    }

    function start() {
      if (running || !model) return;
      running = true;
      phoneHits = othersHits = 0;
      lastPhoneAt = lastOthersAt = 0;
      lastPersonAt = Date.now(); // a moment to settle in before "away" counts
      current = null;
      step();
    }

    function stop() {
      running = false;
      clearTimeout(timer);
      releaseCamera();
      if (current) { current = null; onChange(null); }
    }

    // Try to get the camera back after it was lost (needs a click on some browsers).
    function restart() {
      releaseCamera();
      return openCamera().then(attach).then(function () { cameraLost = false; if (running) evaluate(); });
    }

    return { prepare: prepare, start: start, stop: stop, restart: restart, isReady: function () { return !!model && cameraAlive(); } };
  }

  window.GxCamGuard = { create: create, preload: function () { return loadModel().catch(function () {}); } };
})();
