import * as Comlink from "../utils/comlink.js";
import { logOldSpnMain as log } from "../logger";
import { WebkitAudioContext } from "../utils";
import { requestMidi } from "../utils/request-midi";
import { requestMicrophoneNode } from "./io.utils";
import ScriptProcessorNodeWorker from "../../dist/__compiled.old-spn.worker.inline.js";

// we reuse the spnWorker
// since it handles multiple
// audio Contexts via UID.
let spnWorker;
let proxyPort;

let UID = 0;

class ScriptProcessorNodeMainThread {
  constructor({ audioContext, audioContextIsProvided, autoConnect }) {
    this.isRequestingMidi = false;
    this.isRequestingInput = false;
    this.contextUid = undefined;
    this.iFrameElement = undefined;

    /**
     * @suppress {checkTypes}
     * @type {{triggerRealtimePerformanceStarted: function(Object): void}}
     */
    this.publicEvents = undefined;

    /**
     * @suppress {checkTypes}
     * @type {{audioWorkerFrameRequestPort: function(): void}}
     */
    this.ipcMessagePorts = undefined;

    this.autoConnect = autoConnect;
    this.audioContextIsProvided = audioContextIsProvided;

    this.audioContext = audioContext;
    this.currentPlayState = undefined;

    /**
     * @suppress {checkTypes}
     * @type {{eventPromises: {
     * releaseStartPromise: function(): Promise.<void>,
     * releasePausePromise: function(): Promise.<void>,
     * releaseResumePromise: function(): Promise.<void>,
     * }
     * }}
     */
    this.csoundWorkerMain = undefined;

    // never default these, get it from
    // csound-worker before starting
    this.sampleRate = undefined;
    this.inputsCount = undefined;
    this.outputsCount = undefined;
    this.hardwareBufferSize = undefined;
    this.softwareBufferSize = undefined;

    this.scriptProcessorNode = true;
    log("ScriptProcessorNodeMainThread was constructed")();
  }

  async terminateInstance() {
    if (window[`__csound_wasm_iframe_parent_${this.contextUid}Node`]) {
      window[`__csound_wasm_iframe_parent_${this.contextUid}Node`].disconnect();
      delete window[`__csound_wasm_iframe_parent_${this.contextUid}Node`];
    }
    if (this.audioContext) {
      if (this.audioContext.state !== "closed") {
        try {
          await this.audioContext.close();
        } catch (error) {}
      }
      delete this.audioContext;
    }
    if (proxyPort) {
      proxyPort[Comlink.releaseProxy]();
      proxyPort = undefined;
    }
    if (this.iFrameElement) {
      this.iFrameElement.remove();
    }
    spnWorker = undefined;
    UID = 0;
  }

  async onPlayStateChange(newPlayState) {
    if (this.currentPlayState === newPlayState) {
      return;
    }

    switch (newPlayState) {
      case "realtimePerformanceStarted": {
        log("event received: realtimePerformanceStarted")();
        this.currentPlayState = newPlayState;
        await this.initialize();
        await this.csoundWorkerMain.eventPromises.releaseStartPromise();
        this.publicEvents.triggerRealtimePerformanceStarted(this.csoundWorkerMain);
        break;
      }
      case "realtimePerformanceEnded": {
        log("event received: realtimePerformanceEnded")();
        if (window[`__csound_wasm_iframe_parent_${this.contextUid}Node`]) {
          window[`__csound_wasm_iframe_parent_${this.contextUid}Node`].disconnect();
          delete window[`__csound_wasm_iframe_parent_${this.contextUid}Node`];
        }
        break;
      }

      case "realtimePerformancePaused": {
        if (this.csoundWorkerMain && this.csoundWorkerMain.eventPromises) {
          this.csoundWorkerMain.publicEvents &&
            this.csoundWorkerMain.publicEvents.triggerRealtimePerformancePaused(this);
          await this.csoundWorkerMain.eventPromises.releasePausePromise();
        }
        break;
      }

      case "realtimePerformanceResumed": {
        if (this.csoundWorkerMain && this.csoundWorkerMain.eventPromises) {
          this.csoundWorkerMain.publicEvents &&
            this.csoundWorkerMain.publicEvents.triggerRealtimePerformanceResumed(this);
          await this.csoundWorkerMain.eventPromises.releaseResumePromise();
        }
        break;
      }

      default: {
        break;
      }
    }
    this.currentPlayState = newPlayState;
    if (
      proxyPort &&
      (newPlayState !== "realtimePerformanceStarted" || newPlayState !== "renderStarted")
    ) {
      const setPlayStatePayload = {};
      setPlayStatePayload["contextUid"] = this.contextUid;
      setPlayStatePayload["newPlayState"] = newPlayState;

      await proxyPort["setPlayState"](setPlayStatePayload);
    }
  }

  async initIframe() {
    // HACK FROM (but it works just fine when adding modern security models)
    // https://github.com/GoogleChromeLabs/audioworklet-polyfill/blob/274792e5e3d189e04c9496bed24129118539b4b5/src/realm.js#L18-L20
    if (window === undefined || window.document === undefined) {
      throw new TypeError("Can only run SPN in Browser scope");
    }

    const parentScope = window.document;
    const iFrameHtml = [
      `<!doctype html>`,
      `<html lang="en">`,
      `<head>`,
      `<meta charset="UTF-8">`,
      `</head>`,
      `<body>`,
      `<script type="text/javascript" src="${ScriptProcessorNodeWorker()}"></script>`,
      `</body>`,
    ].join("\n");

    const iFrameBlob = new Blob([iFrameHtml], { type: "text/html" });
    this.iFrameElement = document.createElement("iframe");

    this.iFrameElement.src = URL.createObjectURL(iFrameBlob);
    this.iFrameElement.sandbox.add("allow-scripts", "allow-same-origin");

    this.iFrameElement.style.cssText = "position:absolute;left:0;top:-999px;width:1px;height:1px;";

    // appending early to have access to contentWindow
    const iFrameOnLoad = new Promise((resolve) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      this.iFrameElement.onload = () => {
        resolve();
      };
    });

    parentScope.body.append(this.iFrameElement);

    try {
      await iFrameOnLoad;
    } catch (error) {
      console.error(error);
    }

    spnWorker = this.iFrameElement.contentWindow;
  }

  async initialize() {
    if (!spnWorker) {
      await this.initIframe();
      if (!spnWorker) {
        console.error("SPN FATAL: Couldn't create iFrame");
        return;
      }
    }
    const contextUid = `audioWorklet${UID}`;
    this.contextUid = contextUid;
    UID += 1;

    if (!proxyPort) {
      proxyPort = Comlink.wrap(Comlink.windowEndpoint(spnWorker), undefined);
    }

    if (!this.audioContext) {
      if (this.audioContextIsProvided) {
        console.error(`fatal: the provided AudioContext was undefined`);
      }
      this.audioContext = new (WebkitAudioContext())({ sampleRate: this.sampleRate });
    }
    if (this.audioContext.state === "closed") {
      if (this.audioContextIsProvided) {
        console.error(`fatal: the provided AudioContext was closed, falling back new AudioContext`);
      }
      this.audioContext = new (WebkitAudioContext())({ sampleRate: this.sampleRate });
    }

    if (!this.audioContextIsProvided && this.sampleRate !== this.audioContext.sampleRate) {
      this.audioContext = new (WebkitAudioContext())({ sampleRate: this.sampleRate });
    }

    // just set it both on parent and iframe
    // since 1 works on linux and other one on mac
    // leaking globals indeed
    spnWorker[contextUid] = this.audioContext;
    window[`__csound_wasm_iframe_parent_${contextUid}`] = this.audioContext;

    let liveInput;
    if (this.isRequestingInput) {
      await new Promise((resolve) => {
        const microphoneCallback = (stream) => {
          if (stream) {
            liveInput = this.audioContext.createMediaStreamSource(stream);
          }
          resolve();
        };
        requestMicrophoneNode(microphoneCallback);
      });
    }

    log("initializing proxyPort")();

    const initializePayload = {};

    initializePayload["contextUid"] = contextUid;
    initializePayload["hardwareBufferSize"] = 32768;
    initializePayload["softwareBufferSize"] = 2048;
    initializePayload["inputsCount"] = this.inputsCount;
    initializePayload["outputsCount"] = this.outputsCount;
    initializePayload["sampleRate"] = this.sampleRate;
    initializePayload["audioInputPort"] = this.ipcMessagePorts.audioWorkerAudioInputPort;
    initializePayload["messagePort"] = this.ipcMessagePorts.workerMessagePort2;
    initializePayload["requestPort"] = this.ipcMessagePorts.audioWorkerFrameRequestPort;
    initializePayload["audioContextIsProvided"] = this.audioContextIsProvided;
    initializePayload["autoConnect"] = this.autoConnect;
    initializePayload["initialPlayState"] = this.currentPlayState;

    await proxyPort["initialize"](
      Comlink.transfer(initializePayload, [
        this.ipcMessagePorts.audioWorkerAudioInputPort,
        this.ipcMessagePorts.workerMessagePort2,
        this.ipcMessagePorts.audioWorkerFrameRequestPort,
      ]),
    );
    log("done initializing proxyPort")();

    const audioNode =
      spnWorker[`${contextUid}Node`] || window[`__csound_wasm_iframe_parent_${contextUid}Node`];
    audioNode && liveInput && liveInput.connect(audioNode);

    this.publicEvents.triggerOnAudioNodeCreated(audioNode);

    if (this.isRequestingMidi && this.csoundWorkerMain && this.csoundWorkerMain.handleMidiInput) {
      log("requesting for web-midi connection")();
      requestMidi({
        onMidiMessage: this.csoundWorkerMain.handleMidiInput.bind(this.csoundWorkerMain),
      });
    }
  }
}

export default ScriptProcessorNodeMainThread;
