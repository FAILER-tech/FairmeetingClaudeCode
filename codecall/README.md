# Codecall

Small-group video calls by room code. Camera, microphone, screen sharing and chat, in the browser, with no accounts.

- Up to 8 people per room (set `MAX_PER_ROOM` to change it).
- Video and audio go directly between browsers (WebRTC mesh). The server only passes connection details and chat messages. It does not carry or store video.
- A room exists while someone is in it. Nothing is saved.

## Run it on your computer

```
npm install
npm start
```

Open http://localhost:3000 in two browser windows, pick a code (or press "New code"), and join from both. Browsers allow the camera on `localhost` without https.

## Put it online

Cameras and microphones only work on https pages, and the app needs a host that supports WebSockets. Any Node host works, for example Render, Railway, Fly.io or your own server behind Caddy or nginx.

1. Push this folder to a Git repository.
2. Create a new Node web service from it. Build command: `npm install`. Start command: `npm start`.
3. The host provides https and sets `PORT` for you.

## Calls that will not connect

Most networks connect using the built-in STUN servers. Some strict office or school networks need a relay (TURN). If people report "Connecting…" that never finishes, add a TURN service and set these environment variables:

```
TURN_URLS=turn:your.turn.host:3478,turns:your.turn.host:5349
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-password
```

## Good to know

- Mesh calls send a separate video stream to each person, so they work best with 2 to 6 people. Larger calls need a media server (SFU) such as LiveKit.
- Anyone who has a room code can join. Generated codes are long enough to be hard to guess. Short codes you type yourself are easy to guess.
- Screen sharing is not available in most phone browsers.
- Shortcuts during a call: `M` mute, `V` camera, `C` chat.

## Files

- `server.js` serves the page, keeps track of who is in each room, passes WebRTC signals and relays chat.
- `public/index.html`, `public/style.css`, `public/app.js` are the whole client.
