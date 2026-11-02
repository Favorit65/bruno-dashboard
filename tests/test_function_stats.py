import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from function_stats import FunctionStats, UNRESOLVED
import model_v2


class FunctionStatsTests(unittest.TestCase):
    def setUp(self):
        self.teams = {
            'day': {'name': 'Клининг Д/С Башня ВТБ', 'memberIDs': ['a', 'b'], 'active': True},
            'eve': {'name': 'Клининг В/С Башня Федерация Запад', 'memberIDs': ['a', 'c'], 'active': True},
            'cmd': {'name': 'Коменданты Воронцовская', 'memberIDs': ['d'], 'active': True},
            'adm': {'name': 'Администраторы Башня ВТБ', 'memberIDs': ['b'], 'active': True},
        }

    def test_pool_task_is_counted_once_and_keeps_original_status(self):
        s = FunctionStats(self.teams)
        for status in ('COMPLETED', 'MISSED', 'WAITING', 'COMPLETING', 'NEW'):
            s.add({'teamID': 'day', 'employees': ['a', 'b'], 'status': status,
                   'objectID': 'o', 'completionDeadlineDate': '2020-01-01T00:00:00Z'}, '2026-10-31')
        self.assertEqual(s.count, 5)
        self.assertEqual(len(s.rows), 1)
        key, row = next(iter(s.rows.items()))
        self.assertEqual(key, '2026-10-31|o|Клининг Д/С|day|')
        self.assertEqual(row['unplanned']['MISSED'], 1)
        self.assertEqual(row['unplanned']['WAITING'], 1)

    def test_personal_task_uses_memberships_and_does_not_copy_to_all_shifts(self):
        s = FunctionStats(self.teams)
        r = {'employeeID': 'a', 'status': 'COMPLETED', 'dateLocal': 2026103118}
        self.assertEqual(s.attribution(r)[0], 'Клининг В/С')
        self.assertEqual(s.attribution({**r, 'dateLocal': 202610310800})[0], 'Клининг Д/С')
        self.assertEqual(s.attribution({'employeeID': 'a'})[0], UNRESOLVED)
        self.assertEqual(s.attribution({'employeeID': 'b', 'dateLocal': 202610310800})[0], UNRESOLVED)

    def test_known_executor_and_single_assignee_only(self):
        s = FunctionStats(self.teams)
        self.assertEqual(s.attribution({'teamID': 'day', 'employees': ['a','b'], 'employeeID': 'b'})[2], 'b')
        self.assertEqual(s.attribution({'employees': ['d']})[0], 'Коменданты')
        self.assertEqual(s.attribution({'employees': ['a','b']})[2], '')
        self.assertEqual(s.attribution({'employees': None})[0], UNRESOLVED)

    def test_roles_do_not_substitute_for_team_membership(self):
        s = FunctionStats(self.teams)
        self.assertEqual(s.attribution({'employeeID': 'unknown', 'roleName': 'Комендант'})[0], UNRESOLVED)

    def test_codec_round_trip_team_and_unassigned_executor(self):
        s = FunctionStats(self.teams)
        s.add({'teamID':'day','employees':['a','b'],'objectID':'o','status':'MISSED','taskID':'p'}, '2026-10-31')
        s.add({'employeeID':'d','objectID':'o','status':'COMPLETED'}, '2026-10-31')
        model = {'meta': {'buildId':'unit'}, 'directories': {'objects': {'o':'Test'}, 'teams':self.teams},
                 'daily': {'byFunctionTeamDay': s.rows}}
        core, cubes = model_v2.encode(model)
        decoded = model_v2.decode(core, cubes)
        self.assertEqual(decoded['daily']['byFunctionTeamDay'], s.rows)
        self.assertEqual(cubes['buildId'], 'unit')
        self.assertEqual(core['cubes']['byFunctionTeamDay']['stride'], 19)

    def test_late_completed_remains_completed(self):
        s = FunctionStats(self.teams)
        s.add({'teamID':'cmd', 'employeeID':'d', 'status':'COMPLETED',
               'date_complete':'2026-10-31T11:00:00Z','completionDeadlineDate':'2026-10-31T10:00:00Z'}, '2026-10-31')
        b = next(iter(s.rows.values()))['unplanned']
        self.assertEqual((b['COMPLETED'], b['MISSED'], b['completedLate']), (1,0,1))

    def test_executor_in_open_or_missed_task_does_not_mean_completed(self):
        s = FunctionStats(self.teams)
        for status in ['COMPLETING', 'WAITING', 'MISSED']:
            s.add({'status':status,'employeeID':'a','teamID':'day','taskID':'p'}, '2026-11-02')
        b = next(iter(s.rows.values()))['planned']
        self.assertEqual((b['COMPLETED'], b['MISSED'], b['COMPLETING'], b['WAITING']), (0,1,1,1))

    def test_completed_requires_actual_executor_and_never_uses_single_assignee(self):
        s = FunctionStats(self.teams)
        s.add({'status':'COMPLETED','teamID':'cmd','employees':['d'],'taskID':'p','objectID':'o'}, '2026-11-02')
        self.assertEqual(s.rows, {})
        self.assertEqual(sum(s.completion_anomalies.values()),1)
        s.add({'status':'COMPLETED','employeeID':'d','teamID':'cmd','employees':['d'],'taskID':'p','objectID':'o'}, '2026-11-02')
        self.assertEqual(next(iter(s.rows.values()))['planned']['COMPLETED'],1)


if __name__ == '__main__':
    unittest.main()
