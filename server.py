#!/usr/bin/env python3
"""Локальный сервер скрам-покера: статика + JSON API + SSE."""

from __future__ import annotations

import json
import signal
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

HOST = "0.0.0.0"
PORT = 8080
PUBLIC = Path(__file__).resolve().parent / "public"
DATA = Path(__file__).resolve().parent / "data"
STALE_AFTER = 25.0
VIEWER_NAME = "viewer"
FIBONACCI = ["0", "1", "2", "3", "5", "8", "13", "21", "☕", "⚰️✝️🏳️‍🌈"]

lock = threading.Lock()
rooms: dict[str, dict[str, Any]] = {}

MIME = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


def local_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def now() -> float:
    return time.monotonic()


def normalize_room(value: str) -> str:
    cleaned = "".join(ch for ch in value.strip() if ch.isalnum() or ch in "-_")
    return cleaned[:16] or "poker"


def normalize_name(value: str) -> str:
    name = " ".join(value.strip().split())
    return name[:24]


def bump(room: dict[str, Any]) -> None:
    room["version"] = int(room.get("version", 0)) + 1


def vote_rank(vote: str | None) -> int:
    if vote is None:
        return len(FIBONACCI)
    try:
        return FIBONACCI.index(vote)
    except ValueError:
        return len(FIBONACCI)


def is_moderator(player: dict[str, Any]) -> bool:
    return player.get("role") == "viewer"


def require_moderator(player: dict[str, Any]) -> None:
    if not is_moderator(player):
        raise ValueError("Это может сделать только viewer")


def snapshot_votes(room: dict[str, Any]) -> list[dict[str, Any]]:
    rows = [
        {"name": player["name"], "vote": player["vote"]}
        for player in room["players"].values()
        if player.get("role") != "viewer"
    ]
    rows.sort(key=lambda row: (vote_rank(row["vote"]), row["name"].casefold()))
    return rows


def history_file(room_id: str) -> Path:
    return DATA / f"{normalize_room(room_id)}.json"


def load_history(room_id: str) -> list[Any]:
    path = history_file(room_id)
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = payload.get("history", [])
    return items if isinstance(items, list) else []


def persist_history(room: dict[str, Any]) -> None:
    DATA.mkdir(exist_ok=True)
    path = history_file(str(room["id"]))
    path.write_text(
        json.dumps({"history": room.get("history", [])}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def archive_round(room: dict[str, Any]) -> None:
    title = room["task"] or "Без названия"
    votes = snapshot_votes(room)
    current_id = room.get("historyId")
    if current_id:
        for item in room["history"]:
            if item.get("id") == current_id:
                item["title"] = title
                item["votes"] = votes
                persist_history(room)
                return
    item = {
        "id": str(uuid.uuid4()),
        "title": title,
        "votes": votes,
        "savedAt": int(time.time()),
    }
    room["history"].insert(0, item)
    room["history"] = room["history"][:100]
    room["historyId"] = item["id"]
    persist_history(room)


def room_state(room_id: str) -> dict[str, Any]:
    room = rooms.get(room_id)
    if room is None:
        room = {
            "id": room_id,
            "task": "",
            "revealed": False,
            "players": {},
            "version": 0,
            "history": load_history(room_id),
            "historyId": None,
        }
        rooms[room_id] = room
    return room


def prune(room: dict[str, Any]) -> None:
    cutoff = now() - STALE_AFTER
    stale = [
        pid
        for pid, player in room["players"].items()
        if player["seen"] < cutoff
    ]
    if not stale:
        return
    for pid in stale:
        del room["players"][pid]
    bump(room)


def public_state(room_id: str, viewer_id: str | None) -> dict[str, Any]:
    room = room_state(room_id)
    prune(room)
    revealed = room["revealed"]
    players = []
    for pid, player in room["players"].items():
        show_vote = revealed or pid == viewer_id
        players.append(
            {
                "id": pid,
                "name": player["name"],
                "role": player.get("role", "player"),
                "hasVoted": player["vote"] is not None,
                "vote": player["vote"] if show_vote else None,
                "self": pid == viewer_id,
            }
        )
    players.sort(
        key=lambda item: (
            not item["self"],
            item.get("role") != "viewer",
            item["name"].casefold(),
            item["id"],
        )
    )
    me = room["players"].get(viewer_id or "")
    return {
        "room": room_id,
        "task": room["task"],
        "revealed": revealed,
        "players": players,
        "cards": FIBONACCI,
        "version": room.get("version", 0),
        "history": room.get("history", []),
        "present": bool(viewer_id) and viewer_id in room["players"],
        "moderator": bool(me) and is_moderator(me),
    }


def find_player(room: dict[str, Any], player_id: str) -> dict[str, Any] | None:
    player = room["players"].get(player_id)
    if player is None:
        return None
    player["seen"] = now()
    return player


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0 or length > 32_000:
        return {}
    raw = handler.rfile.read(length)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self.handle_state(parsed)
            return
        if parsed.path == "/api/stream":
            self.handle_stream(parsed)
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        routes = {
            "/api/join": self.handle_join,
            "/api/vote": self.handle_vote,
            "/api/reveal": self.handle_reveal,
            "/api/reset": self.handle_reset,
            "/api/clear": self.handle_clear,
            "/api/history-clear": self.handle_history_clear,
            "/api/task": self.handle_task,
            "/api/ping": self.handle_ping,
            "/api/leave": self.handle_leave,
        }
        action = routes.get(parsed.path)
        if action is None:
            self.send_error_json(404, "Неизвестный запрос")
            return
        action()

    def handle_join(self) -> None:
        data = read_json(self)
        room_id = normalize_room(str(data.get("room", "")))
        role = "viewer" if str(data.get("role", "")).strip().lower() == "viewer" else "player"
        if role == "viewer":
            name = VIEWER_NAME
        else:
            name = normalize_name(str(data.get("name", "")))
            if not name:
                self.send_error_json(400, "Введите имя")
                return
            if name.casefold() == VIEWER_NAME:
                self.send_error_json(400, "Имя viewer занято")
                return
        player_id = str(uuid.uuid4())
        with lock:
            room = room_state(room_id)
            prune(room)
            if role == "viewer" and any(is_moderator(player) for player in room["players"].values()):
                self.send_error_json(409, "В комнате уже есть viewer")
                return
            room["players"][player_id] = {
                "name": name,
                "role": role,
                "vote": None,
                "seen": now(),
            }
            bump(room)
            state = public_state(room_id, player_id)
        self.send_json({"playerId": player_id, **state})

    def handle_vote(self) -> None:
        data = read_json(self)
        value = str(data.get("value", ""))
        if value not in FIBONACCI:
            self.send_error_json(400, "Недопустимая оценка")
            return
        self.with_player(data, lambda room, player: self.cast_vote(room, player, value))

    def cast_vote(self, room: dict[str, Any], player: dict[str, Any], value: str) -> None:
        if is_moderator(player):
            raise ValueError("Viewer не голосует")
        if not room["task"]:
            raise ValueError("Сначала сохраните задачу")
        if room["revealed"]:
            raise ValueError("Голосование уже закрыто")
        player["vote"] = None if player["vote"] == value else value

    def handle_reveal(self) -> None:
        def reveal(room: dict[str, Any], player: dict[str, Any]) -> None:
            require_moderator(player)
            if not room["task"]:
                raise ValueError("Сначала сохраните задачу")
            room["revealed"] = True
            archive_round(room)

        self.with_player(read_json(self), reveal)

    def handle_reset(self) -> None:
        def reset_room(room: dict[str, Any], player: dict[str, Any]) -> None:
            require_moderator(player)
            room["revealed"] = False
            room["historyId"] = None
            room["task"] = ""
            for member in room["players"].values():
                member["vote"] = None

        self.with_player(read_json(self), reset_room)

    def handle_clear(self) -> None:
        def clear_table(room: dict[str, Any], player: dict[str, Any]) -> None:
            require_moderator(player)
            room["players"].clear()
            room["revealed"] = False
            room["historyId"] = None

        self.with_player(read_json(self), clear_table)

    def handle_history_clear(self) -> None:
        def clear_history(room: dict[str, Any], player: dict[str, Any]) -> None:
            require_moderator(player)
            room["history"] = []
            room["historyId"] = None
            persist_history(room)

        self.with_player(read_json(self), clear_history)

    def handle_task(self) -> None:
        data = read_json(self)
        title = " ".join(str(data.get("task", "")).strip().split())[:80]
        if not title:
            self.send_error_json(400, "Введите название задачи")
            return

        def set_task(room: dict[str, Any], player: dict[str, Any]) -> None:
            require_moderator(player)
            room["task"] = title
            current_id = room.get("historyId")
            if not current_id:
                return
            for item in room["history"]:
                if item.get("id") == current_id:
                    item["title"] = title
                    persist_history(room)
                    return

        self.with_player(data, set_task)

    def handle_ping(self) -> None:
        self.with_player(read_json(self), lambda _room, _player: None, mutate=False)

    def handle_leave(self) -> None:
        data = read_json(self)
        room_id = normalize_room(str(data.get("room", "")))
        player_id = str(data.get("playerId", ""))
        with lock:
            room = rooms.get(room_id)
            if room and player_id in room["players"]:
                del room["players"][player_id]
                if room["players"]:
                    bump(room)
                else:
                    persist_history(room)
                    rooms.pop(room_id, None)
            state = public_state(room_id, None) if room_id in rooms else {
                "room": room_id,
                "task": "",
                "revealed": False,
                "players": [],
                "cards": FIBONACCI,
                "version": 0,
                "history": load_history(room_id),
                "present": False,
                "moderator": False,
            }
        self.send_json(state)

    def with_player(self, data: dict[str, Any], action: Any, *, mutate: bool = True) -> None:
        room_id = normalize_room(str(data.get("room", "")))
        player_id = str(data.get("playerId", ""))
        with lock:
            room = rooms.get(room_id)
            if room is None:
                self.send_error_json(404, "Комната не найдена")
                return
            player = find_player(room, player_id)
            if player is None:
                self.send_error_json(401, "Сначала представьтесь")
                return
            try:
                action(room, player)
            except ValueError as exc:
                self.send_error_json(409, str(exc))
                return
            if mutate:
                bump(room)
            state = public_state(room_id, player_id)
        self.send_json(state)

    def handle_state(self, parsed: Any) -> None:
        query = parse_qs(parsed.query)
        room_id = normalize_room((query.get("room") or [""])[0])
        player_id = (query.get("playerId") or [""])[0]
        with lock:
            if player_id:
                room = rooms.get(room_id)
                if room:
                    find_player(room, player_id)
            state = public_state(room_id, player_id or None)
        self.send_json(state)

    def handle_stream(self, parsed: Any) -> None:
        query = parse_qs(parsed.query)
        room_id = normalize_room((query.get("room") or [""])[0])
        player_id = (query.get("playerId") or [""])[0]
        self.send_response(200)
        self.send_cors()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last = ""
        last_ping = now()
        try:
            while True:
                with lock:
                    room = rooms.get(room_id)
                    if room and player_id:
                        find_player(room, player_id)
                    payload = json.dumps(public_state(room_id, player_id or None), ensure_ascii=False)
                if payload != last:
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    last = payload
                elif now() - last_ping > 12:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = now()
                time.sleep(0.25)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return

    def serve_static(self, raw_path: str) -> None:
        path = raw_path.split("?", 1)[0]
        if path in ("", "/"):
            path = "/index.html"
        relative = Path(path.lstrip("/"))
        if ".." in relative.parts:
            self.send_error_json(403, "Запрещено")
            return
        file_path = (PUBLIC / relative).resolve()
        try:
            file_path.relative_to(PUBLIC.resolve())
        except ValueError:
            self.send_error_json(403, "Запрещено")
            return
        if not file_path.is_file():
            self.send_error_json(404, "Страница не найдена")
            return
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_cors()
        self.send_header("Content-Type", MIME.get(file_path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    PUBLIC.mkdir(exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)

    def stop(*_args: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    ip = local_ip()
    print(f"Скрам-покер: http://127.0.0.1:{PORT}", flush=True)
    print(f"В сети:      http://{ip}:{PORT}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        print("Остановлен", flush=True)


if __name__ == "__main__":
    main()
