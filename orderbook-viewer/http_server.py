"""Static research reports with a paced same-origin snapshot-refresh request."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from cache import RefreshRequests


PATHS={'/pro/refresh'}


class ReportHandler(SimpleHTTPRequestHandler):
    def __init__(self,*args,refresh_root,**kwargs):
        self.refresh_requests=RefreshRequests(refresh_root)
        super().__init__(*args,**kwargs)

    def reply(self,status,data):
        raw=json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Connection','close')
        if status==429:self.send_header('Retry-After',str(data['retry_after']))
        self.end_headers();self.wfile.write(raw);self.close_connection=True

    def do_POST(self):
        if urlsplit(self.path).path not in PATHS:
            self.reply(404,{'status':'not_found'});return
        host=self.headers.get('Host','')
        if not host or self.headers.get('Origin')!='http://'+host:
            self.reply(403,{'status':'same_origin_required'});return
        try:length=int(self.headers.get('Content-Length','0'))
        except ValueError:self.reply(400,{'status':'invalid_length'});return
        if self.headers.get('Transfer-Encoding') or length!=0:
            self.reply(413,{'status':'body_too_large'});return
        status,data=self.refresh_requests.request();self.reply(status,data)

    def do_GET(self):
        if urlsplit(self.path).path in PATHS:self.reply(405,{'status':'post_required'});return
        super().do_GET()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,required=True)
    parser.add_argument('--bind',required=True)
    parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--cache-root',type=Path,required=True)
    args=parser.parse_args();os.umask(0o002)
    handler=partial(ReportHandler,directory=str(args.directory),refresh_root=args.cache_root)
    ThreadingHTTPServer((args.bind,args.port),handler).serve_forever()


if __name__=='__main__':main()
