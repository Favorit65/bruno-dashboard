import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BASE=Path(__file__).resolve().parents[1]


class BuildSmokeTest(unittest.TestCase):
    def test_period_buckets_do_not_share_counts(self):
        sys.path.insert(0,str(BASE))
        from dashboard_periods import publish
        from feedback_register import PUBLIC_OBJECTS

        rows = []
        for hour, feedback_id in [(8, 1), (8, 2), (9, 3)]:
            rows.extend([0, hour, 0, 0, 0, 0, 0, 0, feedback_id, 1] + [0] * 17)
        core = {'meta': {'buildId': 'test'}, 'days': ['2026-10-31'], 'roles': ['role'],
                'dirs': {'objects': {'ids': [next(iter(PUBLIC_OBJECTS))]}},
                'cubes': {'byActivity': {'stride': 27, 'rows': rows}}}
        with tempfile.TemporaryDirectory(dir=BASE/'tests') as temp:
            root = Path(temp)
            publish(core, root)
            week = json.loads((root/'week-2026-10-26.json').read_text(encoding='utf-8'))
            hours = json.loads((root/'hour-2026-10-31.json').read_text(encoding='utf-8'))
            index = json.loads((root/'index.json').read_text(encoding='utf-8'))
            self.assertEqual(week['rows'][9::27], [3])
            self.assertEqual(hours['rows'][9::27], [2, 1])
            self.assertEqual(index['history'][9::27], [3])

    def test_builder_publishes_matching_version_and_preserves_waiting(self):
        with tempfile.TemporaryDirectory(dir=BASE/'tests') as temp:
            root=Path(temp);archive=root/'archive';day='2026-10-31'
            dirs=archive/'dirs'/day;raw=archive/'raw'/day;dirs.mkdir(parents=True);raw.mkdir(parents=True)
            obj='a037facd-77d3-4fd6-b2b9-a33b90ab0eb0'
            resources={'object':[{'id':obj,'name':'Test'}], 'zone':[],
                       'user':[{'id':'e','name':'Test employee','active':True,'projects':[{'roleID':'role'}]}],
                       'team':[{'id':'t','name':'Клининг Д/С','active':True,'employees':['e']}],
                       'role':[{'id':'role','name':'Исполнитель'}]}
            for name,rows in resources.items():
                with gzip.open(dirs/(name+'.json.gz'),'wt',encoding='utf-8') as f:json.dump(rows,f)
            with gzip.open(raw/'taskPlan.jsonl.gz','wt',encoding='utf-8') as f:
                for i,status in enumerate(['COMPLETED','MISSED','WAITING']):
                    f.write(json.dumps({'id':str(i),'dateLocal':202610310800,'objectID':obj,'teamID':'t','employees':['e'],
                                        'taskID':'p','status':status,'employeeID':'e' if status=='COMPLETED' else '',
                                        'completionDeadlineDate':'2020-01-01T00:00:00Z',
                                        'feedbackID':'private-request' if i < 2 else 'public-request',
                                        'isPrivate':i == 1,
                                        'feedback':{'date':'2026-10-31T08:00:00Z',
                                                    'text':'Скрытый текст' if i < 2 else 'Почта test@example.org'}})+'\n')
            (archive/'manifest.json').write_text(json.dumps({'days':{day:{'complete':True,'fetchedAt':'2026-10-31T12:00:00Z'}}}),encoding='utf-8')
            result=subprocess.run([sys.executable,str(BASE/'build_model.py'),'--archive',str(archive),'--out',str(root/'model.json.gz')],capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr.decode('utf-8',errors='replace'))
            with gzip.open(root/'model.core.json.gz','rt',encoding='utf-8') as f:core=json.load(f)
            with gzip.open(root/'model.cubes.json.gz','rt',encoding='utf-8') as f:cubes=json.load(f)
            version=json.loads((root/'model.version.json').read_text(encoding='utf-8'))
            self.assertEqual(core['meta']['buildId'],version['buildId']);self.assertEqual(cubes['buildId'],version['buildId'])
            sys.path.insert(0,str(BASE))
            import model_v2
            model=model_v2.decode(core,cubes)
            b=next(iter(model['daily']['byFunctionTeamDay'].values()))['planned']
            self.assertEqual((b['COMPLETED'],b['MISSED'],b['WAITING']),(1,1,1))
            raw=next(iter(model['daily']['byObjectDay'].values()))['planned']
            self.assertEqual((raw['COMPLETED'],raw['MISSED'],raw['WAITING']),(1,1,1))
            self.assertEqual(core['meta']['staleOpenAsMissed'],0)
            self.assertEqual(core['meta']['openPastDeadline'],1)
            requests = {row['id']: row for row in core['feedbackRegister']}
            self.assertEqual(requests['private-request']['text'], '[закрытое обращение]')
            self.assertEqual(requests['public-request']['text'], 'Почта [контакт скрыт]')
            self.assertEqual([row['text'] for row in core['feedbackExamples']], ['Почта [контакт скрыт]'])
            periods = root/'model.periods'
            index = json.loads((periods/'index.json').read_text(encoding='utf-8'))
            week = json.loads((periods/'week-2026-10-26.json').read_text(encoding='utf-8'))
            hours = json.loads((periods/'hour-2026-10-31.json').read_text(encoding='utf-8'))
            details = json.loads((periods/'register-2026-10-26.json').read_text(encoding='utf-8'))
            self.assertEqual(index['weeks'], ['2026-10-26'])
            self.assertEqual(index['hours'], ['2026-10-31'])
            self.assertEqual(index['meta']['buildId'], version['buildId'])
            self.assertTrue(all(part['buildId'] == version['buildId'] for part in (week, hours, details)))
            self.assertNotIn('feedbackRegister', index)
            self.assertTrue(all('text' not in row for row in week['requests']))
            self.assertEqual(details['requests'], core['feedbackRegister'])
            for offset in range(9,27):
                self.assertEqual(sum(week['rows'][offset::27]), sum(hours['rows'][offset::27]))


if __name__=='__main__':unittest.main()
