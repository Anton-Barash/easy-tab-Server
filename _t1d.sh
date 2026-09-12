#!/usr/bin/env bash
AUTH='Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxIiwidXNlcm5hbWUiOiJhbnRvbiIsImlhdCI6MTc4OTE0NTQyOSwiZXhwIjoxNzg5NzUwMjI5fQ.r1khCmVjkTKRvy-jm7Jp8QmpvQR17ZFlWmhDrHFHZ0s'
PUB=ywg556ch6s
TOK=$(curl -sk "https://localhost/reports/$PUB/view-token" -H "$AUTH" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
echo "token: ${TOK:0:20}..."
python3 -c "import base64,json;b=(lambda t: t.split('.')[1]); import sys;p=json.loads(base64.urlsafe_b64decode(b('$TOK')+'===')); print('exp-iat =', p['exp']-p['iat'], 's ; scope =', p.get('scope'))"
echo '--- cookie max-age ---'
curl -sk -c /tmp/ck1d.txt -o /dev/null "https://localhost/auth/redeem-view?token=$TOK&target=/view/report/$PUB"
grep auth_token /tmp/ck1d.txt | awk '{print "Max-Age ~", $5-'"$(date +%s)"', "с"; $7=""; print}'