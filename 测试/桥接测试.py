import importlib.util
import json
import threading
import time
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from concurrent.futures import ThreadPoolExecutor

spec=importlib.util.spec_from_file_location('bridge',Path(__file__).parents[1]/'连接器'/'桥接服务.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.server=m.Bridge(('127.0.0.1',0),'test-token-with-at-least-24-characters')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
    def req(self,path,data=None,auth=True):
        headers={'Content-Type':'application/json'}
        if auth:headers['Authorization']='Bearer '+self.server.token
        req=Request(self.url+path,data=json.dumps(data).encode() if data is not None else None,headers=headers)
        try:
            with urlopen(req,timeout=5) as r:return r.status,json.load(r) if r.status!=204 else None
        except HTTPError as e:return e.code,json.load(e)
    def connect(self):
        self.req('/poll?client=test-file-session&page=1:2')
    def command(self):
        return {'target':'test-file-session','batch':{'expectedPageId':'1:2','operations':[{'action':'page'}]}}
    def test_auth_and_exact_routes(self):
        self.assertEqual(self.req('/health',auth=False)[0],401)
        self.assertEqual(self.req('/health')[0],200)
        self.assertEqual(self.req('/health-unexpected')[0],404)
    def test_reject_unconnected_or_wrong_page(self):
        self.assertEqual(self.req('/command',self.command())[0],409)
        self.connect();c=self.command();c['batch']['expectedPageId']='wrong'
        self.assertEqual(self.req('/command',c)[0],409)
    def test_queued_timeout_cancels(self):
        self.connect();code,result=self.req('/command?timeout=0',self.command())
        self.assertEqual(code,504);self.assertEqual(result['state'],'cancelled')
        self.assertEqual(self.req('/poll?client=test-file-session&page=1:2')[0],204)
    def test_claim_once_and_late_result(self):
        self.connect()
        with ThreadPoolExecutor() as pool:
            future=pool.submit(self.req,'/command?timeout=0.2',self.command())
            for _ in range(100):
                code,job=self.req('/poll?client=test-file-session&page=1:2')
                if code==200:break
                time.sleep(.005)
            self.assertEqual(code,200)
            self.assertEqual(self.req('/poll?client=test-file-session&page=1:2')[0],204)
            self.assertEqual(future.result()[0],202)
        self.assertEqual(self.req('/result',{'id':job['id'],'client':'other','result':{}})[0],403)
        response={'id':job['id'],'client':'test-file-session','result':{'ok':True,'results':[]}}
        self.assertEqual(self.req('/result',response)[0],200)
        self.assertTrue(self.req('/result',response)[1]['duplicate'])
        self.assertEqual(self.req('/commands/'+job['id'])[1]['state'],'done')
    def test_client_target_isolation(self):
        self.connect()
        with ThreadPoolExecutor() as pool:
            f=pool.submit(self.req,'/command?timeout=0.05',self.command())
            self.assertEqual(self.req('/poll?client=other-file&page=1:2')[0],204)
            self.assertEqual(f.result()[0],504)
    def test_bounded_and_invalid_requests(self):
        self.connect();c=self.command();c['batch']['operations']=[]
        self.assertEqual(self.req('/command',c)[0],400)
        self.assertEqual(self.req('/command?timeout=nan',self.command())[0],400)
        self.assertEqual(self.req('/result',{'id':[], 'client':'test', 'result':{}})[0],400)
        self.assertEqual(self.req('/result',{'id':'unknown','client':'test-file-session','result':{}})[0],404)

if __name__=='__main__':unittest.main()
