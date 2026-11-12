# -*- coding: utf-8 -*-
"""OLD PIRATE GAMÃO — servidor Flask + Socket.IO (porta 5000)."""

from __future__ import annotations

import os
import re
import secrets
import socket
import threading
import time
import logging

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

from game import Game, RuleError

logging.getLogger("werkzeug").setLevel(logging.WARNING)

try:  # gevent entrega WebSocket de verdade e aguenta mais jogadores
    import gevent  # noqa: F401
    ASYNC_MODE = "gevent"
except Exception:  # pragma: no cover - fallback para máquinas sem gevent
    ASYNC_MODE = "threading"

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("OPG_SECRET", secrets.token_hex(24))
app.config["TEMPLATES_AUTO_RELOAD"] = True
socketio = SocketIO(
    app,
    async_mode=ASYNC_MODE,
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
    ping_interval=20,
    ping_timeout=40,
)

LOCK = threading.RLock()
USERS: dict[str, dict] = {}      # sid -> {nick, token, table, last_chat}
TABLES: dict[str, dict] = {}     # code -> table
STARTED_AT = time.time()

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TARGETS = (3, 5, 7, 11)
MAX_TABLES = 80
MAX_CHAT = 120


# --------------------------------------------------------------------------- utils
def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


LAN_IP = lan_ip()
PORT = int(os.environ.get("OPG_PORT", "5000"))


def sanitize_nick(raw) -> str | None:
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    raw = re.sub(r"[\x00-\x1f\x7f<>]", "", raw)
    raw = raw[:16].strip()
    if len(raw) < 2:
        return None
    return raw


def sanitize_table_name(raw) -> str:
    if not isinstance(raw, str):
        return ""
    raw = re.sub(r"[\x00-\x1f\x7f<>]", "", raw).strip()
    return raw[:24]


def clean_chat(raw) -> str:
    if not isinstance(raw, str):
        return ""
    raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", raw)
    return raw.strip()[:240]


def new_code() -> str:
    for _ in range(500):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(4))
        if code not in TABLES:
            return code
    raise RuntimeError("sem códigos livres")


def new_token() -> str:
    return secrets.token_urlsafe(18)


def now_ms() -> int:
    return int(time.time() * 1000)


def seat_of_token(table: dict, token: str) -> int | None:
    for i, p in enumerate(table["seats"]):
        if p and p.get("token") == token:
            return i
    return None


def table_of_sid(sid: str):
    u = USERS.get(sid)
    if not u or not u.get("table"):
        return None, None, None
    t = TABLES.get(u["table"])
    if not t:
        return u, None, None
    seat = seat_of_token(t, u["token"])
    spectator = u["token"] in t["spectators"]
    return u, t, None if spectator else seat


def make_table(name: str, target: int) -> dict:
    target = target if target in TARGETS else 5
    code = new_code()
    t = {
        "code": code,
        "name": name or f"Mesa {code}",
        "target": target,
        "seats": [None, None],
        "spectators": {},
        "game": None,
        "chat": [],
        "created": time.time(),
        "last_active": time.time(),
    }
    TABLES[code] = t
    return t


def table_summary(t: dict) -> dict:
    g = t.get("game")
    if not g:
        status = "waiting"
    elif g.match_over:
        status = "finished"
    elif g.game_over:
        status = "intermission"
    else:
        status = "playing"
    players = []
    for p in t["seats"]:
        players.append({"nick": p["nick"], "connected": p["connected"]} if p else None)
    return {
        "code": t["code"],
        "name": t["name"],
        "target": t["target"],
        "players": players,
        "seated": sum(1 for p in t["seats"] if p),
        "spectators": len(t["spectators"]),
        "status": status,
        "scores": list(g.scores) if g else None,
        "game_no": g.game_no if g else 0,
    }


def table_public(t: dict) -> dict:
    return {
        "code": t["code"],
        "name": t["name"],
        "target": t["target"],
        "seats": [
            {
                "nick": p["nick"],
                "connected": p["connected"],
            } if p else None
            for p in t["seats"]
        ],
        "spectators": [
            {"nick": s["nick"], "connected": s["connected"]}
            for s in t["spectators"].values()
        ],
        "state": t["game"].public() if t.get("game") else None,
    }


def lobby_payload() -> dict:
    cleanup_tables()
    tables = []
    for t in TABLES.values():
        summary = table_summary(t)
        summary["_created"] = t["created"]
        tables.append(summary)
    tables.sort(key=lambda x: (x["status"] != "waiting", -x["_created"]))
    for x in tables:
        x.pop("_created", None)
    return {
        "tables": tables,
        "online": len(USERS),
        "lan_url": f"http://{LAN_IP}:{PORT}",
        "uptime": int(time.time() - STARTED_AT),
    }


def cleanup_tables():
    cutoff = time.time() - 60 * 20
    dead = []
    for code, t in list(TABLES.items()):
        anyone = any(p for p in t["seats"]) or t["spectators"]
        all_gone = (
            (any(p for p in t["seats"]) or t["spectators"])
            and not any(p and p.get("connected") for p in t["seats"])
            and not any(s.get("connected") for s in t["spectators"].values())
        )
        if (not anyone and t["last_active"] < cutoff) or (all_gone and t["last_active"] < cutoff):
            dead.append(code)
    for code in dead:
        TABLES.pop(code, None)



def sys_msg(t: dict, text: str, persist: bool = True):
    msg = {"kind": "system", "text": text, "ts": now_ms(), "room": t["code"]}
    if persist:
        t["chat"].append(msg)
        t["chat"] = t["chat"][-MAX_CHAT:]
    socketio.emit("chat", msg, to=t["code"])


def push_table(t: dict):
    t["last_active"] = time.time()
    socketio.emit("table_state", table_public(t), to=t["code"])


def push_lobby():
    socketio.emit("lobby_state", lobby_payload())


def toast(text: str, kind: str = "error"):
    emit("toast", {"kind": kind, "text": text})


def leave_table_internal(t: dict, sid: str, token: str, explicit: bool):
    """Remove (ou apenas desconecta) alguém de uma mesa."""
    was_player = False
    was_spectator = False
    seat = seat_of_token(t, token)
    if seat is not None:
        if explicit:
            t["seats"][seat] = None
            was_player = True
        else:
            t["seats"][seat]["connected"] = False
            was_player = True
    if token in t["spectators"]:
        if explicit:
            del t["spectators"][token]
        else:
            t["spectators"][token]["connected"] = False
        was_spectator = True

    if explicit:
        try:
            leave_room(t["code"], sid=sid)
        except Exception:
            pass
        t["last_active"] = time.time()
        if was_player:
            if t.get("game") is not None:
                # mesa perde a partida em andamento; volta para "aguardando"
                t["game"] = None
                sys_msg(t, "Partida encerrada: um dos jogadores deixou a mesa.")
            sys_msg(t, f"{USERS.get(sid, {}).get('nick', 'Um jogador')} deixou a mesa.")
        elif was_spectator:
            sys_msg(t, f"{USERS.get(sid, {}).get('nick', 'Um espectador')} deixou de assistir.")

    empty = not any(p for p in t["seats"]) and not t["spectators"]
    if empty and explicit:
        TABLES.pop(t["code"], None)
        return
    push_table(t)
    push_lobby()


def detach_user(sid: str, explicit: bool):
    u = USERS.get(sid)
    if not u:
        return
    code = u.get("table")
    if not code:
        return
    t = TABLES.get(code)
    if t:
        leave_table_internal(t, sid, u["token"], explicit)
    u["table"] = None


def emit_table_joined(t: dict, seat: int | None, spectator: bool):
    payload = table_public(t)
    payload.update(
        {
            "seat": seat,
            "spectator": spectator,
            "chat": t["chat"][-MAX_CHAT:],
        }
    )
    emit("table_joined", payload)


# --------------------------------------------------------------------------- rotas
@app.route("/")
def index():
    return render_template("index.html", version=int(STARTED_AT))


@app.route("/api/info")
def api_info():
    return jsonify({"ok": True, "lan_url": f"http://{LAN_IP}:{PORT}", "port": PORT})


@app.route("/health")
def health():
    with LOCK:
        return jsonify({
            "ok": True,
            "tables": len(TABLES),
            "users": len(USERS),
            "mode": socketio.async_mode,
            "port": PORT,
        })


# --------------------------------------------------------------------------- socket
@socketio.on("connect")
def on_connect():
    pass


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    with LOCK:
        detach_user(sid, explicit=False)
        USERS.pop(sid, None)
        for t in TABLES.values():
            if any(x and x.get("sid") == sid for x in t["seats"]):
                push_table(t)
        push_lobby()


@socketio.on("hello")
def on_hello(data):
    data = data or {}
    requested_nick = sanitize_nick(data.get("nick"))
    token = data.get("token")
    if not isinstance(token, str) or not (8 <= len(token) <= 80):
        token = None

    with LOCK:
        sid = request.sid
        existing = None
        if token:
            for t in TABLES.values():
                seat = seat_of_token(t, token)
                if seat is not None:
                    existing = (t, seat)
                    if not requested_nick:
                        requested_nick = t["seats"][seat]["nick"]
                    break
                if token in t["spectators"]:
                    existing = (t, None)
                    if not requested_nick:
                        requested_nick = t["spectators"][token]["nick"]
                    break

        if not requested_nick:
            toast("Nickname inválido. Use de 2 a 16 caracteres.")
            return

        if not token:
            token = new_token()

        old = USERS.get(sid)
        existing_code = existing[0]["code"] if existing else None
        if old and old.get("table") and old.get("table") != existing_code:
            detach_user(sid, explicit=True)

        USERS[sid] = {
            "nick": requested_nick,
            "token": token,
            "table": None,
            "last_chat": 0.0,
        }

        seat = None
        is_spectator = False
        if existing:
            t, existing_seat = existing
            if existing_seat is not None:
                p = t["seats"][existing_seat]
                old_sid = p.get("sid")
                if old_sid and old_sid != sid:
                    other = USERS.get(old_sid)
                    if other:
                        other["table"] = None
                    try:
                        leave_room(t["code"], sid=old_sid)
                    except Exception:
                        pass
                p.update({"nick": requested_nick, "sid": sid, "connected": True})
                seat = existing_seat
                join_room(t["code"])
                USERS[sid]["table"] = t["code"]
            else:
                s = t["spectators"][token]
                old_sid = s.get("sid")
                if old_sid and old_sid != sid:
                    other = USERS.get(old_sid)
                    if other:
                        other["table"] = None
                    try:
                        leave_room(t["code"], sid=old_sid)
                    except Exception:
                        pass
                s.update({"nick": requested_nick, "sid": sid, "connected": True})
                is_spectator = True
                join_room(t["code"])
                USERS[sid]["table"] = t["code"]

            emit(
                "hello_ok",
                {
                    "nick": requested_nick,
                    "token": token,
                    "table": t["code"],
                    "seat": seat,
                    "spectator": is_spectator,
                },
            )
            emit_table_joined(t, seat, is_spectator)
            if existing_seat is not None:
                sys_msg(t, f"{requested_nick} reconectou.", persist=False)
            push_table(t)
        else:
            emit(
                "hello_ok",
                {
                    "nick": requested_nick,
                    "token": token,
                    "table": None,
                    "seat": None,
                    "spectator": False,
                },
            )

        lobby = lobby_payload()
    emit("lobby_state", lobby)


@socketio.on("lobby")
def on_lobby():
    with LOCK:
        payload = lobby_payload()
    emit("lobby_state", payload)


@socketio.on("create_table")
def on_create_table(data):
    data = data or {}
    name = sanitize_table_name(data.get("name"))
    try:
        target = int(data.get("target", 5))
    except (TypeError, ValueError):
        target = 5
    with LOCK:
        u = USERS.get(request.sid)
        if not u:
            toast("Identifique-se primeiro.")
            return
        if len(TABLES) >= MAX_TABLES:
            toast("Limite de mesas atingido. Tente novamente em instantes.")
            return
        detach_user(request.sid, explicit=True)
        t = make_table(name or f"Mesa de {u['nick']}", target)
        _sit_new_player(t, u, request.sid)


@socketio.on("quick_match")
def on_quick_match(data=None):
    with LOCK:
        u = USERS.get(request.sid)
        if not u:
            toast("Identifique-se primeiro.")
            return
        candidates = [
            t
            for t in TABLES.values()
            if t.get("game") is None
            and sum(1 for p in t["seats"] if p) == 1
            and not any(p and p.get("token") == u["token"] for p in t["seats"])
        ]
        candidates.sort(key=lambda t: (not any(p and p["connected"] for p in t["seats"]), t["created"]))
        if candidates:
            detach_user(request.sid, explicit=True)
            _sit_new_player(candidates[0], u, request.sid)
        else:
            detach_user(request.sid, explicit=True)
            t = make_table(f"Mesa de {u['nick']}", 5)
            _sit_new_player(t, u, request.sid)


def _sit_new_player(t: dict, u: dict, sid: str):
    seat = next((i for i in (0, 1) if t["seats"][i] is None), None)
    if seat is None:
        # espectador
        t["spectators"][u["token"]] = {
            "nick": u["nick"],
            "sid": sid,
            "connected": True,
        }
        join_room(t["code"])
        u["table"] = t["code"]
        emit_table_joined(t, None, True)
        sys_msg(t, f"{u['nick']} entrou como espectador.")
        push_table(t)
        push_lobby()
        return

    t["seats"][seat] = {
        "nick": u["nick"],
        "token": u["token"],
        "sid": sid,
        "connected": True,
    }
    join_room(t["code"])
    u["table"] = t["code"]
    sys_msg(t, f"{u['nick']} entrou na mesa.")
    emit_table_joined(t, seat, False)
    t["last_active"] = time.time()

    if all(t["seats"]) and t["game"] is None:
        t["game"] = Game(target=t["target"])
        first = t["game"].turn
        sys_msg(
            t,
            f"Partida iniciada. {t['seats'][first]['nick']} começa. "
            f"Match até {t['target']} pontos.",
        )
    push_table(t)
    push_lobby()


@socketio.on("join_table")
def on_join_table(data):
    data = data or {}
    code = str(data.get("code", "")).strip().upper()[:8]
    with LOCK:
        u = USERS.get(request.sid)
        if not u:
            toast("Identifique-se primeiro.")
            return
        t = TABLES.get(code)
        if not t:
            toast("Mesa não encontrada. Confira o código.")
            return
        if u.get("table") == code:
            emit_table_joined(t, seat_of_token(t, u["token"]), u["token"] in t["spectators"])
            return
        detach_user(request.sid, explicit=True)
        _sit_new_player(t, u, request.sid)


@socketio.on("leave_table")
def on_leave_table():
    with LOCK:
        u = USERS.get(request.sid)
        if not u:
            return
        detach_user(request.sid, explicit=True)
        lobby = lobby_payload()
    emit("table_left", {})
    emit("lobby_state", lobby)


@socketio.on("logout")
def on_logout():
    """Encerra a sessão do socket: libera mesa/assento e volta ao login no cliente."""
    sid = request.sid
    with LOCK:
        detach_user(sid, explicit=True)
        USERS.pop(sid, None)
        push_lobby()


@socketio.on("chat")
def on_chat(data):
    data = data or {}
    text = clean_chat(data.get("text"))
    if not text:
        return
    with LOCK:
        u = USERS.get(request.sid)
        if not u or not u.get("table"):
            return
        t = TABLES.get(u["table"])
        if not t:
            return
        now = time.time()
        if now - u.get("last_chat", 0) < 0.55:
            return
        if len(text) > 240:
            text = text[:240]
        u["last_chat"] = now
        seat = seat_of_token(t, u["token"])
        msg = {
            "kind": "chat",
            "nick": u["nick"],
            "text": text,
            "ts": now_ms(),
            "seat": seat if seat is not None else -1,
            "room": t["code"],
        }
        t["chat"].append(msg)
        t["chat"] = t["chat"][-MAX_CHAT:]
        t["last_active"] = now
    socketio.emit("chat", msg, to=t["code"])


# --------------------------------------------------------------------------- jogo
def _game_context(sid):
    u, t, seat = table_of_sid(sid)
    if not u:
        toast("Sessão expirada. Recarregue a página.")
        return None, None, None, None
    if not t:
        toast("Você não está em uma mesa.")
        return u, None, None, None
    g = t.get("game")
    if not g:
        toast("A partida ainda não começou.")
        return u, t, seat, None
    if seat is None:
        toast("Espectadores só podem assistir.")
        return u, t, None, g
    return u, t, seat, g


def _after_action(t: dict):
    push_table(t)
    push_lobby()
    g = t.get("game")
    if g and g.game_over and not t.get("_announced_result"):
        t["_announced_result"] = True
        r = g.result
        winner_nick = t["seats"][r["winner"]]["nick"] if t["seats"][r["winner"]] else f"P{r['winner'] + 1}"
        if r["match_over"]:
            sys_msg(t, f"{winner_nick} venceu o match por {g.scores[r['winner']]} × {g.scores[1 - r['winner']]}.")
        elif r["declined"]:
            sys_msg(t, f"Dobra recusada. {winner_nick} leva {r['points']} ponto(s).")
        else:
            extra = {1: "", 2: " (gammon)", 3: " (backgammon)"}.get(r["multiplier"], "")
            sys_msg(t, f"{winner_nick} venceu o jogo{extra}: +{r['points']} ponto(s). "
                       f"Placar {g.scores[0]} × {g.scores[1]}.")
    elif g and not g.game_over:
        t["_announced_result"] = False


@socketio.on("roll")
def on_roll():
    with LOCK:
        u, t, seat, g = _game_context(request.sid)
        if not g or seat is None:
            return
        try:
            g.roll(seat)
        except RuleError as exc:
            toast(str(exc))
            return
        if g.phase == "no_moves":
            code, seq = t["code"], g.seq
            socketio.start_background_task(_auto_pass, code, seq)
        _after_action(t)


@socketio.on("move")
def on_move(data):
    data = data or {}
    frm = data.get("from")
    to = data.get("to")
    if frm != "bar":
        try:
            frm = int(frm)
        except (TypeError, ValueError):
            toast("Origem inválida.")
            return
    if to != "off":
        try:
            to = int(to)
        except (TypeError, ValueError):
            toast("Destino inválido.")
            return
    with LOCK:
        u, t, seat, g = _game_context(request.sid)
        if not g or seat is None:
            return
        try:
            g.make_move(seat, frm, to)
        except RuleError as exc:
            toast(str(exc))
            return
        _after_action(t)


@socketio.on("pass")
def on_pass():
    with LOCK:
        u, t, seat, g = _game_context(request.sid)
        if not g or seat is None:
            return
        try:
            g.pass_turn(seat)
        except RuleError as exc:
            toast(str(exc))
            return
        _after_action(t)


@socketio.on("offer_double")
def on_offer_double():
    with LOCK:
        u, t, seat, g = _game_context(request.sid)
        if not g or seat is None:
            return
        try:
            g.offer_double(seat)
            sys_msg(t, f"{u['nick']} ofereceu uma dobra. O cubo valeria ×{g.cube['value'] * 2}.")
        except RuleError as exc:
            toast(str(exc))
            return
        _after_action(t)


@socketio.on("double_response")
def on_double_response(data):
    data = data or {}
    accept = bool(data.get("accept"))
    with LOCK:
        u, t, seat, g = _game_context(request.sid)
        if not g or seat is None:
            return
        try:
            g.respond_double(seat, accept)
        except RuleError as exc:
            toast(str(exc))
            return
        if accept:
            sys_msg(t, f"{u['nick']} aceitou a dobra. Cubo em ×{g.cube['value']} (dono: {u['nick']}).")
        else:
            sys_msg(t, f"{u['nick']} recusou a dobra.")
        _after_action(t)


@socketio.on("next_game")
def on_next_game():
    with LOCK:
        u, t, seat, g = _game_context(request.sid)
        if not g or seat is None:
            return
        try:
            g.next_game()
        except RuleError as exc:
            toast(str(exc))
            return
        t["_announced_result"] = False
        starter = t["seats"][g.turn]["nick"] if t["seats"][g.turn] else "?"
        sys_msg(t, f"Novo jogo #{g.game_no}. {starter} começa. Match até {g.target} pontos.")
        _after_action(t)


@socketio.on("new_match")
def on_new_match():
    with LOCK:
        u, t, seat, g = _game_context(request.sid)
        if not g or seat is None:
            return
        if not g.match_over:
            toast("O match ainda está em andamento.")
            return
        g.new_match()
        t["_announced_result"] = False
        starter = t["seats"][g.turn]["nick"] if t["seats"][g.turn] else "?"
        sys_msg(t, f"Novo match até {g.target}. {starter} começa.")
        _after_action(t)


def _auto_pass(code: str, seq: int):
    socketio.sleep(1.6)
    with LOCK:
        t = TABLES.get(code)
        if not t:
            return
        g = t.get("game")
        if not g or g.game_over or g.phase != "no_moves" or g.seq != seq:
            return
        try:
            g.pass_turn(g.turn)
        except RuleError:
            return
        _after_action(t)


# --------------------------------------------------------------------------- main
if __name__ == "__main__":
    print("=" * 62)
    print("  OLD PIRATE GAMÃO  ::  servidor local")
    print(f"  local  -> http://127.0.0.1:{PORT}")
    print(f"  lan    -> http://{LAN_IP}:{PORT}")
    print(f"  motor  -> {socketio.async_mode}")
    print("=" * 62)
    socketio.run(app, host="0.0.0.0", port=PORT, debug=False, allow_unsafe_werkzeug=True)
