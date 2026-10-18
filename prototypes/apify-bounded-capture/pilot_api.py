"""Throwaway pilot utility. Private data directory; never retry an ambiguous start."""
import argparse, datetime, json, os, pathlib, urllib.error, urllib.parse, urllib.request
os.umask(0o077)
ROOT = pathlib.Path(os.environ["PILOT_DATA_DIR"]).expanduser().resolve()
ROOT.mkdir(parents=True, exist_ok=True)
TOKEN = pathlib.Path(os.environ["APIFY_TOKEN_FILE"]).expanduser().read_text().strip()
TERMINAL = {'SUCCEEDED','FAILED','TIMED-OUT','ABORTED'}
def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')
def api(path, method='GET', body=None, query=None, anonymous=False):
    url='https://api.apify.com/v2/'+path
    if query: url+='?'+urllib.parse.urlencode(query)
    headers={'Content-Type':'application/json'}
    if not anonymous: headers['Authorization']='Bearer '+TOKEN
    req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=45) as r: return json.load(r)
def restrict(run, directory):
    outcomes=[]
    for typ,identifier in [('actor-runs',run['id']),('datasets',run['defaultDatasetId']),('key-value-stores',run['defaultKeyValueStoreId']),('request-queues',run['defaultRequestQueueId'])]:
        path=typ+'/'+identifier
        try:
            result=api(path,'PUT',{'generalAccess':'RESTRICTED'})
            assert result['data']['generalAccess']=='RESTRICTED'
            try:
                api(path,anonymous=True)
                anonymous_status=200
            except urllib.error.HTTPError as e: anonymous_status=e.code
            outcomes.append({'type':typ,'restricted':True,'anonymousStatus':anonymous_status})
        except urllib.error.HTTPError as e:
            outcomes.append({'type':typ,'restricted':False,'status':e.code})
    save(directory/'access.json',outcomes)
    print('Privacy:',outcomes)
def collect(name):
    directory=ROOT/'runs'/name
    initial=json.loads((directory/'start.json').read_text())['data']
    run=api('actor-runs/'+initial['id'],query={'waitForFinish':30})['data']
    save(directory/'run.json',run)
    if not (directory/'access.json').exists(): restrict(run,directory)
    print(json.dumps({'name':name,'status':run['status'],'message':run.get('statusMessage'),'usageTotalUsd':run.get('usageTotalUsd'),'chargedEventCounts':run.get('chargedEventCounts'),'durationMs':run.get('stats',{}).get('durationMillis')}))
    if run['status'] not in TERMINAL: return
    rows=[]; offset=0
    while True:
        batch=api('datasets/'+run['defaultDatasetId']+'/items',query={'format':'json','offset':offset,'limit':500,'clean':'false'})
        save(directory/f'page-{offset}.json',batch); rows.extend(batch)
        if len(batch)<500: break
        offset+=len(batch)
    save(directory/'items.json',rows)
    keys=api('key-value-stores/'+run['defaultKeyValueStoreId']+'/keys')['data']
    save(directory/'keys.json',keys)
    for item in keys.get('items',[]):
        if item['key'] in ('INPUT',): continue
        try: save(directory/('kv-'+item['key'].replace('/','_')+'.json'),api('key-value-stores/'+run['defaultKeyValueStoreId']+'/records/'+urllib.parse.quote(item['key'],safe='')))
        except (ValueError,urllib.error.HTTPError): pass
    print('Archived dataset rows:',len(rows),'KV keys:',[x['key'] for x in keys.get('items',[])])
def start(name,input_path,cap):
    directory=ROOT/'runs'/name
    if directory.exists(): raise SystemExit('Existing reservation. Use collect or reconcile; do not restart.')
    reserved=sum(json.loads(p.read_text())['maxTotalChargeUsd'] for p in (ROOT/'runs').glob('*/reservation.json')) if (ROOT/'runs').exists() else 0
    assert reserved+cap<=1.50, 'Reserve $0.50 of the $2 budget for overhead and reconciliation.'
    payload=json.loads(pathlib.Path(input_path).read_text())
    directory.mkdir(parents=True)
    opts={'build':'1.12.394','timeout':120,'memory':256,'maxTotalChargeUsd':cap,'restartOnError':'false','forcePermissionLevel':'LIMITED_PERMISSIONS'}
    save(directory/'reservation.json',{'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),**opts})
    save(directory/'input.json',payload)
    result=api('acts/wAusCMrm284Voaw86/runs','POST',payload,opts)
    save(directory/'start.json',result)
    restrict(result['data'],directory)
    collect(name)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['start','collect']);p.add_argument('name');p.add_argument('--input');p.add_argument('--cap',type=float);a=p.parse_args()
    if a.command=='start': start(a.name,a.input,a.cap)
    else: collect(a.name)
