# -*- coding: utf-8 -*-
"""OLD PIRATE GAMMON — motor de regras completas de gamão (backgammon).

Convenções internas:
  * Jogador 0 (verde)  -> fichas positivas, anda de 24 para 1, casa 1..6.
  * Jogador 1 (âmbar)  -> fichas negativas, anda de 1 para 24, casa 19..24.
  * points[1..24] guarda a quantidade com sinal.
  * bar[0], bar[1] = fichas capturadas.  off[0], off[1] = fichas fora.
"""

from __future__ import annotations

import random
from functools import lru_cache

HOME = (tuple(range(1, 7)), tuple(range(19, 25)))
DIR = (-1, 1)


class RuleError(Exception):
    """Jogada inválida."""


def sign_of(player: int) -> int:
    return 1 if player == 0 else -1


def new_points() -> list[int]:
    p = [0] * 25
    p[24] = 2
    p[13] = 5
    p[8] = 3
    p[6] = 5
    p[1] = -2
    p[12] = -5
    p[17] = -3
    p[19] = -5
    return p


def pip_count(points, bar: int, player: int) -> int:
    s = sign_of(player)
    total = bar * 25
    if player == 0:
        total += sum(i * points[i] for i in range(1, 25) if points[i] > 0)
    else:
        total += sum((25 - i) * (-points[i]) for i in range(1, 25) if points[i] < 0)
    return total


def _single_moves(points, bar: int, player: int, die: int):
    """Movimentos possíveis de UM dado. Retorna (origem, destino); origem 'bar' ou 1..24,
    destino 1..24 ou 'off'."""
    s = 1 if player == 0 else -1
    moves = []

    if bar > 0:
        dest = 25 - die if player == 0 else die
        if points[dest] * s >= -1:
            moves.append(("bar", dest))
        return moves

    home = HOME[player]
    all_home = True
    for i in range(1, 25):
        if i not in home and points[i] * s > 0:
            all_home = False
            break

    max_dist = 0
    if all_home:
        for i in home:
            if points[i] * s > 0:
                d = i if player == 0 else 25 - i
                if d > max_dist:
                    max_dist = d

    for frm in range(1, 25):
        if points[frm] * s <= 0:
            continue
        dist = frm if player == 0 else 25 - frm
        to = frm + DIR[player] * die
        if 1 <= to <= 24:
            if points[to] * s >= -1:
                moves.append((frm, to))
        elif all_home:
            # Não há como andar além da borda: só pode tirar ficha.
            if die == dist:
                moves.append((frm, "off"))
            elif die > dist and max_dist == dist:
                moves.append((frm, "off"))
    return moves


def _apply(points, bar: int, player: int, frm, to):
    """Aplica uma jogada do jogador da vez (ignora o bar do adversário)."""
    s = sign_of(player)
    p = list(points)
    b = bar
    if frm == "bar":
        b -= 1
    else:
        p[frm] -= s
    if to != "off":
        if p[to] == -s:
            p[to] = 0  # captura
        p[to] += s
    return tuple(p), b


@lru_cache(maxsize=400_000)
def _max_use(points, bar: int, player: int, dice: tuple) -> int:
    """Quantos dados, no máximo, ainda podem ser usados nesta jogada."""
    if not dice:
        return 0
    best = 0
    seen = set()
    for i, die in enumerate(dice):
        if die in seen:
            continue
        seen.add(die)
        for frm, to in _single_moves(points, bar, player, die):
            np, nb = _apply(points, bar, player, frm, to)
            nd = dice[:i] + dice[i + 1:]
            cand = 1 + _max_use(np, nb, player, nd)
            if cand > best:
                best = cand
            if best == len(dice):
                return best
    return best


def all_home(points, player: int) -> bool:
    s = sign_of(player)
    for i in range(1, 25):
        if i not in HOME[player] and points[i] * s > 0:
            return False
    return True


class Game:
    """Uma partida (match) completa: games, cubo de dobra e Crawford."""

    def __init__(self, target: int = 5, rng: random.Random | None = None):
        self.rng = rng or random.Random()
        self.target = max(3, int(target))
        self.scores = [0, 0]
        self.crawford_used = False
        self.match_over = False
        self.match_winner = None
        self.game_no = 0
        self.seq = 0
        self.next_first = self.rng.randint(0, 1)
        self.start_game()

    # ------------------------------------------------------------------ setup
    def start_game(self):
        self.game_no += 1
        self.seq += 1
        self.points = new_points()
        self.bar = [0, 0]
        self.off = [0, 0]
        self.turn = self.next_first
        self.next_first = 1 - self.next_first
        self.phase = "to_roll"          # to_roll | moving | no_moves | double_offered | game_over
        self.dice = []
        self.dice_owner = None
        self.remaining = []
        self.used = 0
        self.best = 0
        self._legal = []
        self.cube = {"value": 1, "owner": None}
        self.double_offer = None
        self.game_over = False
        self.result = None
        self.log = []
        self.crawford = False
        if not self.crawford_used:
            if ((self.scores[0] == self.target - 1 and self.scores[1] < self.target) or
                    (self.scores[1] == self.target - 1 and self.scores[0] < self.target)):
                self.crawford = True
                self.crawford_used = True

    def new_match(self):
        self.scores = [0, 0]
        self.crawford_used = False
        self.match_over = False
        self.match_winner = None
        self.game_no = 0
        self.next_first = self.rng.randint(0, 1)
        self.start_game()

    def next_game(self):
        if not self.game_over:
            raise RuleError("O jogo atual ainda não terminou.")
        if self.match_over:
            raise RuleError("O match já terminou.")
        self.start_game()

    # ------------------------------------------------------------------ helpers
    def _note(self, text: str):
        self.log.append(text)
        self.log = self.log[-60:]

    def _bump(self):
        self.seq += 1

    def _end_turn(self):
        self.turn = 1 - self.turn
        self.phase = "to_roll"
        self.remaining = []
        self.used = 0
        self.best = 0
        self._legal = []
        self.double_offer = None
        self._bump()

    def player_name(self, player: int) -> str:
        return f"Jogador {player + 1}"

    # ------------------------------------------------------------------ actions
    def roll(self, player: int):
        if self.game_over:
            raise RuleError("O jogo já terminou.")
        if self.phase != "to_roll":
            raise RuleError("Não é hora de lançar os dados.")
        if player != self.turn:
            raise RuleError("Não é a sua vez.")
        d1 = self.rng.randint(1, 6)
        d2 = self.rng.randint(1, 6)
        self.dice = [d1, d2]
        self.dice_owner = player
        rolled = [d1, d2] if d1 != d2 else [d1, d1, d1, d1]
        self.remaining = sorted(rolled)
        self.used = 0
        self.best = _max_use(tuple(self.points), self.bar[player], player, tuple(self.remaining))
        self.phase = "moving" if self.best > 0 else "no_moves"
        self._legal = self._compute_legal()
        self._note(f"Dados: {d1} + {d2}" + (" (duplo)" if d1 == d2 else ""))
        self._bump()
        return d1, d2

    def _compute_legal(self):
        if self.phase != "moving":
            return []
        player = self.turn
        out = []
        seen = set()
        seen_dice = set()
        rem = self.remaining
        max_die_only = None
        if self.best == 1 and self.used == 0:
            # Regra: se ambos os dados podem ser jogados isoladamente (mas não juntos),
            # é obrigatório jogar o maior. Se só o menor é jogável, joga-se o menor.
            usable = set()
            for d in set(rem):
                if _single_moves(tuple(self.points), self.bar[player], player, d):
                    usable.add(d)
            if len(usable) > 1:
                max_die_only = max(usable)
        for i, die in enumerate(rem):
            if die in seen_dice:
                continue
            seen_dice.add(die)
            if max_die_only is not None and die != max_die_only:
                continue
            for frm, to in _single_moves(tuple(self.points), self.bar[player], player, die):
                np, nb = _apply(tuple(self.points), self.bar[player], player, frm, to)
                nd = tuple(sorted(rem[:i] + rem[i + 1:]))
                if self.used + 1 + _max_use(np, nb, player, nd) == self.best:
                    key = (frm, to)
                    if key not in seen:
                        seen.add(key)
                        out.append((frm, to, die))
        return out

    def make_move(self, player: int, frm, to):
        if self.game_over:
            raise RuleError("O jogo já terminou.")
        if self.phase != "moving":
            raise RuleError("Lance os dados antes de mover.")
        if player != self.turn:
            raise RuleError("Não é a sua vez.")

        entry = None
        for mv in self._legal:
            if mv[0] == frm and mv[1] == to:
                entry = mv
                break
        if entry is None:
            raise RuleError("Movimento ilegal.")
        die = entry[2]

        s = sign_of(player)
        hit = False
        if frm == "bar":
            self.bar[player] -= 1
        else:
            self.points[frm] -= s
        if to == "off":
            self.off[player] += 1
        else:
            if self.points[to] == -s:
                self.points[to] = 0
                self.bar[1 - player] += 1
                hit = True
            self.points[to] += s

        self.remaining.remove(die)
        self.used += 1
        origin = "bar" if frm == "bar" else str(frm)
        dest = "off" if to == "off" else str(to)
        self._note(f"{self._nick(player)}  {origin} → {dest}" + ("  · captura" if hit else ""))
        self._bump()

        if self.off[player] == 15:
            self._finish_win(player)
            return

        if self.used >= self.best or not self.remaining:
            self._end_turn()
            return

        self._legal = self._compute_legal()
        if not self._legal:
            self._end_turn()

    def pass_turn(self, player: int):
        if self.game_over:
            raise RuleError("O jogo já terminou.")
        if self.phase != "no_moves":
            raise RuleError("Você ainda tem jogadas.")
        if player != self.turn:
            raise RuleError("Não é a sua vez.")
        self._note(f"{self._nick(player)} não tinha jogadas.")
        self._end_turn()

    def offer_double(self, player: int):
        if self.game_over:
            raise RuleError("O jogo já terminou.")
        if self.phase != "to_roll":
            raise RuleError("Só é possível dobrar antes de lançar os dados.")
        if player != self.turn:
            raise RuleError("Não é a sua vez.")
        if self.crawford:
            raise RuleError("Jogo de Crawford: dobra proibida.")
        if self.cube["owner"] not in (None, player):
            raise RuleError("O cubo pertence ao adversário.")
        if self.cube["value"] >= 64:
            raise RuleError("O cubo chegou ao limite (64).")
        self.phase = "double_offered"
        self.double_offer = player
        self._note(f"{self._nick(player)} ofereceu o cubo (×{self.cube['value'] * 2}).")
        self._bump()

    def respond_double(self, player: int, accept: bool):
        if self.phase != "double_offered" or self.double_offer is None:
            raise RuleError("Não há dobra pendente.")
        if player == self.double_offer:
            raise RuleError("Espere a resposta do adversário.")
        offerer = self.double_offer
        if accept:
            self.cube["value"] *= 2
            self.cube["owner"] = player   # quem aceita passa a ser dono do cubo
            self.double_offer = None
            self.phase = "to_roll"
            self._note(f"{self._nick(player)} aceitou o cubo: ×{self.cube['value']}.")
            self._bump()
        else:
            self._note(f"{self._nick(player)} recusou o cubo.")
            self._end_by_decline(offerer)

    def _end_by_decline(self, winner: int):
        points = self.cube["value"] * 1
        self._finish_game(winner, points, 1, declined=True)

    def _finish_win(self, winner: int):
        loser = 1 - winner
        multiplier = 1
        if self.off[loser] == 0:
            s_loser = sign_of(loser)
            in_winner_home = any(self.points[i] * s_loser > 0 for i in HOME[winner])
            backgammon = self.bar[loser] > 0 or in_winner_home
            multiplier = 3 if backgammon else 2
        points = self.cube["value"] * multiplier
        label = {1: "", 2: " (gammon)", 3: " (backgammon)"}[multiplier]
        self._note(f"{self._nick(winner)} venceu{label} e marcou {points} ponto(s).")
        self._finish_game(winner, points, multiplier, declined=False)

    def _finish_game(self, winner: int, points: int, multiplier: int, declined: bool):
        self.scores[winner] += points
        self.game_over = True
        self.phase = "game_over"
        self.double_offer = None
        self._legal = []
        match_over = self.scores[winner] >= self.target
        if match_over:
            self.match_over = True
            self.match_winner = winner
        self.result = {
            "winner": winner,
            "points": points,
            "multiplier": multiplier,
            "cube": self.cube["value"],
            "declined": declined,
            "match_over": match_over,
        }
        self._bump()

    def _nick(self, player: int) -> str:
        return f"P{player + 1}"

    # ------------------------------------------------------------------ public
    def public(self) -> dict:
        legal = []
        for frm, to, die in self._legal:
            legal.append({"from": frm, "to": to, "die": die})
        can_double = (
            not self.game_over
            and self.phase == "to_roll"
            and not self.crawford
            and self.cube["value"] < 64
            and self.cube["owner"] in (None, self.turn)
        )
        return {
            "seq": self.seq,
            "points": list(self.points),
            "bar": list(self.bar),
            "off": list(self.off),
            "turn": self.turn,
            "phase": self.phase,
            "dice": list(self.dice),
            "dice_owner": self.dice_owner,
            "remaining": list(self.remaining),
            "used": self.used,
            "best": self.best,
            "legal": legal,
            "pips": [pip_count(self.points, self.bar[0], 0),
                     pip_count(self.points, self.bar[1], 1)],
            "scores": list(self.scores),
            "target": self.target,
            "game_no": self.game_no,
            "cube": dict(self.cube),
            "can_double": can_double,
            "double_offer": self.double_offer,
            "crawford": self.crawford,
            "game_over": self.game_over,
            "result": self.result,
            "match_over": self.match_over,
            "match_winner": self.match_winner,
            "log": self.log[-12:],
        }
