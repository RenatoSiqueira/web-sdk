import { Socket, Channel } from "phoenix";
interface VexConfig {
  url: string;
  onDisconnect: () => void;
}

interface VexRoomConfig {
  displayName: string;
  onPeerJoined?: (peer: Peer) => void;
  onPeerMedia?: (peer: Peer, event: MediaStream) => void;
  onPeerServerRef?: (peerId: string, serverRef: string) => void;
  onPeerLeft?: (peer: Peer) => void;
  onPeerUpdated?: (peer: Peer) => void;
  onPeerCountUpdated?: (count: number) => void;
  onPeerAudioLevelChanged?: (peer: Peer, audioLevel: number) => void;
  onPeerNativeMessage?: (peer: Peer, message: any) => void;
  onPeerJsonMessage?: (peer: Peer, message: any) => void;
  onPeerWsMessage?: (message: any) => void;
}

interface VexDevices {
  audioInputDevices: Array<MediaDeviceInfo>;
  videoInputDevices: Array<MediaDeviceInfo>;
  audioOutputDevices: Array<MediaDeviceInfo>;
}

export class Peer {
  id: string;
  displayName: string;
  active: boolean;
  screenshareOwnerPeerId: string;
  video: boolean;
  audio: boolean;
}

export class Vex {
  public url: string;
  private onDisconnect: () => void;
  private localStream: Promise<MediaStream>;

  constructor(config: VexConfig) {
    this.url = config.url;
    this.onDisconnect = config.onDisconnect;
  }

  connect(): Promise<VexConnection> {
    const socket = new Socket(this.url + "/socket", {});

    socket.onClose(() => this.onDisconnect());

    socket.connect();

    return new Promise((resolve, reject) => {
      socket.onError((error) => reject(error));
      socket.onOpen(() => {
        const conn = new VexConnection(this.url, socket);
        resolve(conn);
      });
    });
  }

  getMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    this.localStream = navigator.mediaDevices.getUserMedia(constraints);
    return this.localStream;
  }

  async getDevices(): Promise<VexDevices> {
    const devices = await navigator.mediaDevices.enumerateDevices();

    let audioInputDevices: Array<MediaDeviceInfo> = [];
    let videoInputDevices: Array<MediaDeviceInfo> = [];
    let audioOutputDevices: Array<MediaDeviceInfo> = [];

    devices.forEach(function (device: MediaDeviceInfo) {
      if (device.kind == "audioinput") {
        audioInputDevices.push(device);
      }
      if (device.kind == "videoinput") {
        videoInputDevices.push(device);
      }
      if (device.kind == "audiooutput") {
        audioOutputDevices.push(device);
      }
    });

    return { audioInputDevices, videoInputDevices, audioOutputDevices }
  }
}

export class VexConnection {
  public url: string;
  private socket: Socket;

  constructor(url: string, socket: Socket) {
    this.url = url;
    this.socket = socket;
  }

  joinRoom(roomId: string, jwt: String, config: VexRoomConfig): Promise<VexRoom> {
    const channel = this.socket.channel("room:" + roomId, { displayName: config.displayName, jwt: jwt });

    channel.onClose((event) => {
      console.error("Phoenix channel got closed", event);
    });

    channel.onError((error) => {
      console.error("Phoenix channel errored", error);
    });

    return new Promise((resolve, reject) => {
      channel
        .join()
        .receive("ok", ({ peer, peersInRoom, participantCount, dataChannelsEnabled }) => {
          console.debug("joined");
          resolve(new VexRoom(this.url, roomId, channel, peer, peersInRoom, participantCount, dataChannelsEnabled, config));
        })
        .receive("error", (resp) => {
          console.error("Unable to join room " + roomId, resp);
          reject(new Error("Unable to join room"));
        });
    });
  }
}

export class VexRoom {
  public url: string;
  public roomId: string;
  private channel: Channel;
  private nativeDataChannel?: RTCDataChannel;
  public dataChannelsEnabled: boolean;
  private dataWs: WebSocket;
  public peer: Peer;
  public peersInRoom: { [peerId: string]: Peer } = {};
  private peerConnections: { [peerId: string]: RTCPeerConnection } = {};
  private onPeerJoined?: (peer: Peer) => void;
  private onPeerMedia?: (peer: Peer, stream: MediaStream) => void;
  private onPeerServerRef?: (peerId: string, serverRef: string) => void;
  private onPeerLeft?: (peer: Peer) => void;
  private onPeerUpdated?: (peer: Peer) => void;
  private onPeerCountUpdated?: (count: number) => void;
  private onPeerAudioLevelChanged?: (peer: Peer, audioLevel: number) => void;
  private onPeerNativeMessage?: (peer: Peer, message: any) => void;
  private onPeerJsonMessage?: (peer: Peer, message: any) => void;
  private onPeerWsMessage?: (message: any) => void;
  private screensharePeerId: string = "725aacbb-cdca-4386-9de5-1cbb7d5964b5";
  private audioLevelsInterval: number;
  public audioLevelsCheckEvery: number = 100;

  constructor(url: string, roomId: string, channel: Channel, peer: Peer, peersInRoom: Peer[], participantCount: number, dataChannelsEnabled: boolean, config: VexRoomConfig) {
    this.url = url;
    this.roomId = roomId;
    this.channel = channel;
    this.peer = peer;
    this.dataChannelsEnabled = dataChannelsEnabled;

    this.onPeerJoined = config.onPeerJoined;
    this.onPeerMedia = config.onPeerMedia;
    this.onPeerServerRef = config.onPeerServerRef;
    this.onPeerLeft = config.onPeerLeft;
    this.onPeerUpdated = config.onPeerUpdated;
    this.onPeerCountUpdated = config.onPeerCountUpdated;
    this.onPeerAudioLevelChanged = config.onPeerAudioLevelChanged;
    this.onPeerNativeMessage = config.onPeerNativeMessage;
    this.onPeerJsonMessage = config.onPeerJsonMessage;
    this.onPeerWsMessage = config.onPeerWsMessage;

    console.log("-> self", peer);
    console.log("-> peers in room", peersInRoom);

    peersInRoom.forEach((peer) => {
      this.peersInRoom[peer.id] = peer;
      this.onPeerJoined?.(peer);
    });

    this.onPeerCountUpdated?.(participantCount);

    this.channel.on("answer", (answer) => {
      console.log("-> answer", answer);

      this.peerConnections[this.peer.id].setRemoteDescription(new RTCSessionDescription(answer));
    });

    this.channel.on("answer-screenshare", (answer) => {
      console.log("-> answer-screenshare", answer);

      this.peerConnections[this.screensharePeerId].setRemoteDescription(new RTCSessionDescription(answer));
    });

    this.channel.on("offer", (msg) => {
      console.log("-> offer", msg);

      if (this.peerConnections.hasOwnProperty(msg.publisherPeerId)) {
        console.warn("Received and ignoring an offer from an already known peer id", msg.publisherPeerId);
      } else {
        let connection = this.createRTCConnection(msg.publisherPeerId, msg.serverRef);
        this.peerConnections[msg.publisherPeerId] = connection;
        this.sendAnswer(msg.serverRef, msg.publisherPeerId, msg.offer);
        this.onPeerServerRef?.(msg.publisherPeerId, msg.serverRef);
      }
    });

    this.channel.on("retryOnPeerJoined", ({ id }) => {
      console.log("-> retrying onPeerJoined", id);
      setTimeout(() => this.receiveMediaFrom(id), 1000);
    });

    this.channel.on("onPeerJoined", (peer) => {
      console.log("-> peer joined", peer);

      this.peersInRoom[peer.id] = peer;
      this.onPeerJoined?.(peer);
    });

    this.channel.on("onPeerLeft", (peer) => {
      console.log("-> peer left", peer);

      delete this.peersInRoom[peer.id];

      if (this.peerConnections[peer.id]) {
        try {
          this.peerConnections[peer.id].close();
        } catch (e) { }
      }
      delete this.peerConnections[peer.id];

      this.onPeerLeft?.(peer);
    });

    this.channel.on("onPeerUpdated", (peer: Peer) => {
      this.onPeerUpdated?.(peer);
    });

    this.channel.on("onPeerCountUpdated", (event: any) => {
      this.onPeerCountUpdated?.(event.count);
    });

    this.channel.on("onBroadcast", (data) => {
      this.onPeerJsonMessage?.(data.peer, data.message);
    })

    // TODO: stop this timer on disconnect
    this.audioLevelsInterval = window.setInterval(() => this.checkAudioLevels(), this.audioLevelsCheckEvery);

    // ws
    this.connectDataWs();
  }

  sendMedia(stream: MediaStream) {
    this.peerConnections[this.peer.id] = this.createRTCConnection(this.peer.id);

    for (const track of stream.getTracks()) {
      if (track.kind == "video") {
        track.contentHint = "detail";
      }
      this.peerConnections[this.peer.id].addTrack(track, stream);
    }

    this.sendOfferFor(this.peerConnections[this.peer.id]);
  }

  receiveMediaFrom(peerId: string) {
    this.channel.push("subscribe_to", { id: peerId });
  }

  stopSendingMedia() {
    this.peerConnections[this.peer.id].getSenders().forEach((sender: RTCRtpSender) => {
      sender.track?.stop();
    });
    this.peerConnections[this.peer.id].close();
    delete this.peerConnections[this.peer.id];
  }

  async startScreenshare(): Promise<MediaStream> {
    const displayMediaStreamConstraints = {
      audio: false,
      video: {
        width: { ideal: window.screen.width, max: window.screen.width },
        height: { ideal: window.screen.height, max: window.screen.height },
        frameRate: { ideal: 15 },
      },
    };
    const screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaStreamConstraints);

    let connection = this.createRTCConnection(this.screensharePeerId);
    this.peerConnections[this.screensharePeerId] = connection;

    for (const track of screenStream.getTracks()) {
      track.contentHint = "detail";
      this.peerConnections[this.screensharePeerId].addTrack(track, screenStream);
    }

    this.sendOfferFor(this.peerConnections[this.screensharePeerId], "offer-screenshare");

    return screenStream;
  }

  stopScreenshare() {
    this.peerConnections[this.screensharePeerId].getSenders().forEach((sender: RTCRtpSender) => {
      sender.track?.stop();
    });

    this.peerConnections[this.screensharePeerId].close();
    delete this.peerConnections[this.screensharePeerId];
  }

  muteSelf() {
    this.setEnabledSenderTracks("audio", false);
    this.channel.push("update_audio", { enabled: false });
  }

  unmuteSelf() {
    this.setEnabledSenderTracks("audio", true);
    this.channel.push("update_audio", { enabled: true });
  }

  async setMicrophone(deviceId: string) {
    const stream = await this.getDeviceAudioStream(deviceId);
    const audioTrack = stream.getAudioTracks()[0];
    this.replaceSenderTracks("audio", audioTrack);
  }

  hideSelf() {
    this.setEnabledSenderTracks("video", false);
    this.channel.push("update_video", { enabled: false });
  }

  showSelf() {
    this.setEnabledSenderTracks("video", true);
    this.channel.push("update_video", { enabled: true });
  }

  async setVideo(deviceId: string) {
    const stream = await this.getDeviceVideoStream(deviceId);
    // change remote videos
    const videoTrack = stream.getVideoTracks()[0];
    this.replaceSenderTracks("video", videoTrack);
    // change local video
    this.onPeerMedia?.(this.peer, stream);
  }

  async setAudioOutput(deviceId: string) {
    // TODO: maybe we should not assume that *all* video elements in the page are related to a room
    const videoElements = <HTMLMediaElement[]>Array.from(document.querySelectorAll('video')).filter((e) => e instanceof HTMLMediaElement);
    videoElements.forEach((e) => {
      // @ts-ignore
      e.setSinkId?.(deviceId);
    });
  }

  // data channels
  sendNativeMessage(message: any) {
    if (this.nativeDataChannel) {
      this.nativeDataChannel.send(message);
    } else {
      console.error("Could not send message, no send data channel available");
    }
  }

  sendJsonMessage(message: any) {
    this.channel.push("broadcast", { message: message });
  }

  sendWsMessage(message: any) {
    this.dataWs.send(message);
  }

  private replaceSenderTracks(type: string, track: MediaStreamTrack) {
    this.peerConnections[this.peer.id].getSenders().forEach((sender: RTCRtpSender) => {
      if (sender.track?.kind === type) {
        const enabled = sender.track.enabled;
        sender.replaceTrack(track).then(() => {
          if (sender.track) { sender.track.enabled = enabled; }
        });
      }
    });
  }

  private setEnabledSenderTracks(type: string, enabled: boolean) {
    this.peerConnections[this.peer.id].getSenders().forEach((sender: RTCRtpSender) => {
      if (sender.track?.kind == type) {
        sender.track.enabled = enabled;
      }
    });
  }

  private getDeviceAudioStream(deviceId): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: {
          exact: deviceId!,
        },
      },
    });
  }

  private getDeviceVideoStream(deviceId): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: {
          exact: deviceId!,
        },
      },
    });
  }

  private createRTCConnection(peerId: string, serverRef: string | undefined = undefined): RTCPeerConnection {
    const pcConfig = {
      iceServers: [{ urls: "stun:secretariat.fly.dev:5000" }],
    };

    var pc = new RTCPeerConnection(pcConfig);

    if (this.dataChannelsEnabled) {
      const channel = pc.createDataChannel("JanusDataChannel");

      channel.onmessage = ((event: MessageEvent) => {
        this.onPeerNativeMessage?.(this.peersInRoom[peerId], event.data);
      })

      if (peerId == this.peer.id) {
        this.nativeDataChannel = channel;
        this.nativeDataChannel.onclose = (() => delete this.nativeDataChannel);
      }
    }

    pc.addEventListener("icecandidate", (event) => {
      console.log("-> icecandidate", event);

      if (event.candidate != null) {
        const sanitizedCandidate = {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        };
        this.channel.push("trickle", {
          candidate: sanitizedCandidate,
          peerId: peerId,
          serverRef: serverRef,
        });
      } else {
        // no more ICE Candidates
      }
    });

    pc.addEventListener("track", (event) => {
      console.log("-> track", event);
      this.onPeerMedia?.(this.peersInRoom[peerId], event.streams[0]);
    });

    // tracking the random disconnects
    pc.addEventListener("connectionstatechange", (event) => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        console.warn(peerId, "connectionstatechange", event, pc.connectionState, pc)
      }
    });

    pc.addEventListener("iceconnectionstatechange", (event) => {
      if (["disconnected", "failed", "closed"].includes(pc.iceConnectionState)) {
        console.warn(peerId, "iceconnectionstatechange", event, pc.iceConnectionState, pc)
      }
    });

    pc.addEventListener("negotiationneeded", (event) => { console.warn(peerId, "negotiationneeded", event, pc) });

    return pc;
  }

  private sendOfferFor(pc: RTCPeerConnection, eventName: string = "offer") {
    pc.createOffer()
      .then((offer) => {
        return pc.setLocalDescription(offer);
      })
      .then(() => {
        this.channel.push(eventName, pc.localDescription);
      })
      .catch(function (reason) {
        console.error("error while creating offer", reason);
      });
  }

  private sendAnswer(serverRef: string, publisherPeerId: string, offer: any) {
    this.peerConnections[publisherPeerId]
      .setRemoteDescription(offer)
      .then(() => this.peerConnections[publisherPeerId].createAnswer())
      .then((answer) => this.peerConnections[publisherPeerId].setLocalDescription(answer))
      .then(() => {
        this.channel.push("answer", {
          answer: this.peerConnections[publisherPeerId].localDescription,
          publisherPeerId: publisherPeerId,
          serverRef: serverRef,
        });
      })
      .catch((e) => console.error(e));
  }

  private checkAudioLevels() {
    for (const [peerId, pc] of Object.entries(this.peerConnections)) {
      if (peerId == this.screensharePeerId) {
        return;
      }

      const receiver = pc.getReceivers().find((r) => {
        return r.track.kind === "audio";
      });

      if (receiver && receiver.track) {
        pc.getStats(receiver.track).then((stats) => {
          stats.forEach((report) => {
            if (report.type === "track" && report.kind === "audio") {
              this.onPeerAudioLevelChanged?.(this.peersInRoom[peerId], report.audioLevel);
            }
          });
        });
      }
    }
  }

  private connectDataWs() {
    // TODO: handle reconnects
    this.dataWs = new WebSocket(this.url + "/data/" + this.roomId + "/" + this.peer.id + "/websocket");
    this.dataWs.onopen = () => { console.log("data-ws opened"); }
    this.dataWs.onclose = () => { console.log("data-ws closed"); }
    this.dataWs.onerror = error => { console.error("data-ws error", error); };
    this.dataWs.onmessage = message => { this.onPeerWsMessage?.(message); };
  }
}
