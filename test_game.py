# -*- coding: utf-8 -*-
"""Testes do motor de regras do Old Pirate Gammon."""
import random
import unittest

from game import Game, RuleError, _max_use, _single_moves, new_points, pip_count


def empty():
    return [0] * 25


class TestRules(unittest.TestCase):
    def test_initial_setup(self):
        p = new_points()
        self.assertEqual(sum(x for x in p if x > 0), 15)
        self.assertEqual(sum(-x for x in p if x < 0), 15)
        self.assertEqual(pip_count(p, 0, 0), 167)
        self.assertEqual(pip_count(p, 0, 1), 167)

    def test_blocked_point(self):
        p = empty()
        p[10] = 1
        p[8] = -2       # bloqueado
        self.assertEqual(_single_moves(p, 0, 0, 2), [])

    def test_hit(self):
        p = empty()
        p[10] = 1
        p[8] = -1
        self.assertIn((10, 8), _single_moves(p, 0, 0, 2))
        p[8] = -2
        self.assertNotIn((10, 8), _single_moves(p, 0, 0, 2))

    def test_bar_priority(self):
        p = empty()
        p[10] = 1
        p[6] = -1
        self.assertEqual(_single_moves(p, 1, 0, 3), [("bar", 22)])
        p[22] = -2
        self.assertEqual(_single_moves(p, 1, 0, 3), [])
        # não pode mexer outras fichas enquanto estiver na barra
        self.assertFalse(any(f == 10 for f, _ in _single_moves(p, 1, 0, 3)))

    def test_bear_off_exact(self):
        p = empty()
        p[6] = 2
        p[5] = 1
        moves = _single_moves(p, 0, 0, 6)
        self.assertIn((6, "off"), moves)
        self.assertNotIn((5, "off"), moves)
        moves = _single_moves(p, 0, 0, 5)
        self.assertIn((5, "off"), moves)
        self.assertNotIn((6, "off"), moves)

    def test_bear_off_high_die(self):
        p = empty()
        p[3] = 1
        self.assertIn((3, "off"), _single_moves(p, 0, 0, 5))
        p[4] = 1
        self.assertNotIn((3, "off"), _single_moves(p, 0, 0, 5))
        self.assertIn((4, "off"), _single_moves(p, 0, 0, 5))

    def test_bear_off_requires_all_home(self):
        p = empty()
        p[6] = 1
        p[10] = 1
        self.assertNotIn((6, "off"), _single_moves(p, 0, 0, 6))
        self.assertIn((10, 4), _single_moves(p, 0, 0, 6))

    def test_only_one_die_must_use_higher(self):
        g = Game(target=5, rng=random.Random(7))
        g.points = empty()
        g.bar = [1, 0]
        g.points[23] = -2         # entrada com 2 bloqueada
        g.points[20] = 0          # entrada com 5 livre
        g.points[18] = -2         # depois de entrar em 20, o 2 também não joga
        g.turn = 0
        g.phase = "to_roll"
        g.dice = [2, 5]
        g.remaining = [2, 5]
        g.used = 0
        g.best = _max_use(tuple(g.points), 1, 0, (2, 5))
        self.assertEqual(g.best, 1)
        g.phase = "moving"
        g._legal = g._compute_legal()
        self.assertTrue(g._legal)
        self.assertTrue(all(die == 5 for _, _, die in g._legal))

    def test_lower_die_when_higher_unplayable(self):
        g = Game(target=5, rng=random.Random(8))
        g.points = empty()
        g.bar = [1, 0]
        g.points[23] = 0          # entrada com 2 livre
        g.points[20] = -2         # entrada com 5 bloqueada
        g.points[18] = -2         # depois de entrar em 23, o 5 não joga
        g.turn = 0
        g.phase = "moving"
        g.dice = [2, 5]
        g.remaining = [2, 5]
        g.used = 0
        g.best = _max_use(tuple(g.points), 1, 0, (2, 5))
        self.assertEqual(g.best, 1)
        g._legal = g._compute_legal()
        self.assertTrue(g._legal)
        self.assertTrue(all(die == 2 for _, _, die in g._legal))


    def test_doubles_four_moves(self):
        g = Game(target=5, rng=random.Random(1))
        g.points = empty()
        g.points[10] = 4
        g.points[1] = 1
        g.bar = [0, 0]
        g.turn = 0
        g.phase = "to_roll"
        g.dice = [3, 3]
        g.dice_owner = 0
        g.remaining = [3, 3, 3, 3]
        g.used = 0
        g.best = _max_use(tuple(g.points), 0, 0, (3, 3, 3, 3))
        self.assertEqual(g.best, 4)
        g.phase = "moving"
        g._legal = g._compute_legal()
        self.assertTrue(g._legal)

    def test_gammon_and_backgammon_points(self):
        # gammon: perdedor sem fichas na casa do vencedor e sem fichas na barra
        g = Game(target=11, rng=random.Random(3))
        g.off = [15, 0]
        g.points = empty()
        g.points[10] = -1
        g._finish_win(0)
        self.assertTrue(g.game_over)
        self.assertEqual(g.result["points"], 2)
        # backgammon: perdedor com ficha na barra
        g = Game(target=11, rng=random.Random(3))
        g.off = [15, 0]
        g.points = empty()
        g.points[1] = -1
        g.bar[1] = 1
        g._finish_win(0)
        self.assertEqual(g.result["points"], 3)

    def test_cube_accept_and_decline(self):
        g = Game(target=11, rng=random.Random(4))
        g.phase = "to_roll"
        g.turn = 0
        g.offer_double(0)
        self.assertEqual(g.phase, "double_offered")
        g.respond_double(1, True)
        self.assertEqual(g.cube["value"], 2)
        self.assertEqual(g.cube["owner"], 1)
        self.assertEqual(g.phase, "to_roll")

        g2 = Game(target=11, rng=random.Random(5))
        g2.phase = "to_roll"
        g2.turn = 0
        g2.offer_double(0)
        g2.respond_double(1, False)
        self.assertTrue(g2.game_over)
        self.assertEqual(g2.result["winner"], 0)
        self.assertEqual(g2.result["points"], 1)
        self.assertTrue(g2.result["declined"])

    def test_crawford(self):
        g = Game(target=3, rng=random.Random(6))
        g.scores = [2, 1]
        g.start_game()
        self.assertTrue(g.crawford)
        g.phase = "to_roll"
        g.turn = 0
        with self.assertRaises(RuleError):
            g.offer_double(0)


class TestRandomGames(unittest.TestCase):
    def test_fuzz_random_games(self):
        rng = random.Random(1234)
        for _ in range(150):
            g = Game(target=rng.choice([3, 5, 7]), rng=rng)
            guard = 0
            while not g.game_over:
                guard += 1
                self.assertLess(guard, 4000)
                if g.phase == "to_roll":
                    g.roll(g.turn)
                elif g.phase == "no_moves":
                    g.pass_turn(g.turn)
                elif g.phase == "moving":
                    before_used = g.used
                    moves = list(g._legal)
                    self.assertTrue(moves)
                    frm, to, die = rng.choice(moves)
                    g.make_move(g.turn, frm, to)
                    if g.phase == "game_over":
                        break
                    if g.used > before_used:
                        self.assertLessEqual(g.used, g.best)
                elif g.phase == "double_offered":
                    g.respond_double(1 - g.double_offer, rng.random() < 0.6)
                else:
                    self.fail(f"fase inesperada: {g.phase}")
            self.assertIn(g.result["winner"], (0, 1))
            self.assertGreaterEqual(g.result["points"], 1)
            self.assertIn(g.scores[g.result["winner"]], range(1, 200))
            # contagem de fichas consistente
            for pl in (0, 1):
                s = 1 if pl == 0 else -1
                on_board = sum(x * s for x in g.points if x * s > 0)
                self.assertEqual(on_board + g.bar[pl] + g.off[pl], 15)

    def test_roll_and_turn_progression(self):
        g = Game(target=5, rng=random.Random(9))
        for _ in range(120):
            if g.phase == "game_over":
                break
            if g.phase == "to_roll":
                g.roll(g.turn)
            self.assertIn(g.phase, ("moving", "no_moves", "game_over"))
            if g.phase == "moving":
                used = 0
                while g.phase == "moving":
                    frm, to, die = g._legal[0]
                    g.make_move(g.turn, frm, to)
                    used += 1
                    self.assertLessEqual(used, 4)
                self.assertLessEqual(used, g.best if g.best else 4)
            elif g.phase == "no_moves":
                g.pass_turn(g.turn)


if __name__ == "__main__":
    unittest.main(verbosity=2)
