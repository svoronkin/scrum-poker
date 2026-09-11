# Scrum poker

[Русский](README.md) · [English](README.en.md)

A local [planning poker](https://en.wikipedia.org/wiki/Planning_poker) web app for estimating tasks. No extra packages: Python 3 and a browser.

Open one room for the team. Players vote with Fibonacci cards, the facilitator (`viewer`) names the task, reveals the cards, and reviews history.

## How to play

1. A player enters a name, picks a room, and clicks **Sit down**.
2. The facilitator joins the same room with **Viewer**. The name field is not used.
3. Players see the table right away. The facilitator enters a task ID and presses Enter or **Save** — the title appears above the table and the deck opens for players.
4. Players pick a card: `0 1 2 3 5 8 13 21`, plus ☕ and ⚰️✝️🏳️‍🌈. Votes can be changed until the cards are revealed. You see your own card face-up; others see a card back.
5. The facilitator clicks **Reveal cards**. A summary appears and the round is stored on the **Tasks** tab.
6. **New task** resets votes. **Clear players** removes everyone from the room.

Only `viewer` can save a task, reveal cards, start a new round, clear the table, and wipe history. Viewer does not vote.

The room link is copied from the header button (`?room=…`).

The UI language can be switched with **RU / EN** (saved in the browser).

## Requirements

- Python 3.12+ (standard library only)
- or Docker / Podman

## Run locally

```bash
python3 server.py
```

The server listens on `0.0.0.0:8080`. The console prints:

- http://127.0.0.1:8080 — this machine
- `http://<IP>:8080` — other devices on the network

Room history is written to `data/` (gitignored).

## Pre-built image

The image is not stored in git. GitHub Actions publishes it to [GitHub Container Registry](https://github.com/svoronkin/scrum-poker/pkgs/container/scrum-poker):

```bash
docker pull ghcr.io/svoronkin/scrum-poker:latest
docker run --rm -p 8080:8080 -v poker-data:/app/data ghcr.io/svoronkin/scrum-poker:latest
```

Rootless Podman in WSL forwards the port through pasta, which Windows `localhost` often cannot see. Run with host networking:

```bash
podman pull ghcr.io/svoronkin/scrum-poker:latest
podman run --rm --network=host -v poker-data:/app/data ghcr.io/svoronkin/scrum-poker:latest
```

Then open http://127.0.0.1:8080 in the Windows browser.

Tags: `latest` (`main` branch), `sha-<commit>`, and `v1.2.3` for releases.

After the first publish, open the package → **Package settings** → **Change visibility** → **Public**, otherwise `docker pull` without login will fail.

## Build locally

```bash
docker compose up --build
```

Or manually:

```bash
docker build -t scrum-poker:latest .
docker run --rm -p 8080:8080 -v poker-data:/app/data scrum-poker:latest
```

Same commands work with Podman: `podman build` / `podman run`.

Open http://127.0.0.1:8080. The `poker-data` volume stores saved votes.

## License

[GNU LGPL 2.1](LICENSE)
