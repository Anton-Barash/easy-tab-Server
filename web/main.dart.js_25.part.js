((a,b)=>{a[b]=a[b]||{}})(self,"$__dart_deferred_initializers__")
$__dart_deferred_initializers__.current=function(a,b,c,$){var J,A,C,B={Nv:function Nv(){},aKE:function aKE(d,e){this.a=d
this.b=e},aKF:function aKF(d,e,f){this.a=d
this.b=e
this.c=f},aKG:function aKG(d,e,f,g,h,i,j){var _=this
_.a=d
_.b=e
_.c=f
_.d=g
_.e=h
_.f=i
_.r=j},aKC:function aKC(d,e,f,g,h,i){var _=this
_.a=d
_.b=e
_.c=f
_.d=g
_.e=h
_.f=i},aKD:function aKD(d,e,f){this.a=d
this.b=e
this.c=f},aKH:function aKH(d,e,f){this.a=d
this.b=e
this.c=f},
bby(d,e){var x
if(e==null)return new self.Blob(d)
x={}
x.type=e
return new self.Blob(d,x)}},D
J=c[1]
A=c[0]
C=c[2]
B=a.updateHolder(c[10],B)
D=c[41]
B.Nv.prototype={
vv(d,e,f,g){var x=1000
return this.ahd(d,e,f,g)},
ahd(d,e,f,g){var x=0,w=A.y(y.n),v,u=2,t=[],s=[],r=this,q,p,o
var $async$vv=A.u(function(h,i){if(h===1){t.push(i)
x=u}for(;;)switch(x){case 0:p=1000
o=(self.URL||self.webkitURL).createObjectURL(B.bby([d],null))
o.toString
q=o
u=3
x=6
return A.p(r.FF(q,p,f,e,g,!0),$async$vv)
case 6:o=i
v=o
s=[1]
x=4
break
s.push(5)
x=4
break
case 3:s=[2]
case 4:u=2;(self.URL||self.webkitURL).revokeObjectURL(q)
x=s.pop()
break
case 5:case 1:return A.w(v,w)
case 2:return A.v(t.at(-1),w)}})
return A.x($async$vv,w)},
LT(d,e,f,g){return this.ahe(d,e,f,g)},
ahe(d,e,f,g){var x=0,w=A.y(y.n),v,u=this
var $async$LT=A.u(function(h,i){if(h===1)return A.v(i,w)
for(;;)switch(x){case 0:v=u.au_(d,1000,f,e,g)
x=1
break
case 1:return A.w(v,w)}})
return A.x($async$LT,w)},
FF(d,e,f,g,h,i){return this.au0(d,e,f,g,h,i)},
au_(d,e,f,g,h){return this.FF(d,e,f,g,h,!1)},
au0(d,e,f,g,h,i){var x=0,w=A.y(y.n),v,u,t,s,r,q,p
var $async$FF=A.u(function(j,k){if(j===1)return A.v(k,w)
for(;;)switch(x){case 0:t={}
s=new A.at($.an,y.m)
r=new A.bn(s,y.x)
q=document
p=q.createElement("video")
y.i.a(p)
p.src=d
if(!i)p.crossOrigin="anonymous"
p.preload="auto"
p.muted=!0
u=p.style
u.display="none"
p.setAttribute("playsinline","true")
q=q.body
if(q!=null)q.appendChild(p).toString
p.load()
t.a=null
t.a=A.dd(D.UJ,new B.aKE(r,p))
q=y.c
u=y.F
new A.yz(p,"error",!1,q).gT(0).cq(new B.aKF(t,p,r),u)
new A.yz(p,"loadedmetadata",!1,q).gT(0).cq(new B.aKG(t,r,e,p,f,g,h),u).lT(new B.aKH(t,p,r))
v=s
x=1
break
case 1:return A.w(v,w)}})
return A.x($async$FF,w)}}
var z=a.updateTypes([])
B.aKE.prototype={
$0(){var x=this.a
if((x.a.a&30)===0){C.fx.eH(this.b)
x.da(0,null)}},
$S:0}
B.aKF.prototype={
$1(d){var x=this.a.a
if(x!=null)x.bx(0)
C.fx.eH(this.b)
x=this.c
if((x.a.a&30)===0)x.da(0,null)},
$S:136}
B.aKG.prototype={
$1(d){var x,w,v=this,u=v.b
if((u.a.a&30)!==0)return
x=v.d
w=x.duration
w.toString
x.currentTime=C.d.aX(v.c/1000,0,w)
w=v.a
new A.yz(x,"seeked",!1,y.c).gT(0).cq(new B.aKC(w,u,x,v.e,v.f,v.r),y.F).lT(new B.aKD(w,x,u))},
$S:136}
B.aKC.prototype={
$1(d){var x,w,v,u,t,s,r,q,p,o,n,m,l,k=this,j=k.b
if((j.a.a&30)!==0)return
n=k.a.a
if(n!=null)n.bx(0)
try{n=document.createElement("canvas")
n.toString
x=n
n=k.c
m=n.videoWidth
m.toString
w=m
m=n.videoHeight
m.toString
v=m
if(J.e(w,0)||J.e(v,0)){C.fx.eH(n)
j.da(0,null)
return}u=C.d.aX(k.d/w,0,C.d.aX(k.e/v,0,1/0))
t=C.d.aP(w*u)
s=C.d.aP(v*u)
x.width=t
x.height=s
m=x.getContext("2d")
m.toString
r=m
J.bnT(r,n,0,0,t,s)
q=J.bnH(x,"image/jpeg",k.f/100)
p=C.c.gak(J.akX(q,","))
o=C.QU.cn(p)
C.fx.eH(n)
j.da(0,new Uint8Array(A.bE(o)))}catch(l){C.fx.eH(k.c)
j.da(0,null)}},
$S:136}
B.aKD.prototype={
$1(d){var x=this.a.a
if(x!=null)x.bx(0)
C.fx.eH(this.b)
x=this.c
if((x.a.a&30)===0)x.da(0,null)},
$S:14}
B.aKH.prototype={
$1(d){var x=this.a.a
if(x!=null)x.bx(0)
C.fx.eH(this.b)
x=this.c
if((x.a.a&30)===0)x.da(0,null)},
$S:14};(function inheritance(){var x=a.inherit,w=a.inheritMany
x(B.Nv,A.D)
x(B.aKE,A.iW)
w(A.eF,[B.aKF,B.aKG,B.aKC,B.aKD,B.aKH])})()
var y={F:A.a_("bz"),i:A.a_("yk"),x:A.a_("bn<eu?>"),c:A.a_("yz<aY>"),m:A.a_("at<eu?>"),n:A.a_("eu?")};(function constants(){D.UJ=new A.b3(1e7)})()};
(a=>{a["pWAsLTkkJnqI7vNIEH8gYv6vm/Q="]=a.current})($__dart_deferred_initializers__);