((a,b)=>{a[b]=a[b]||{}})(self,"$__dart_deferred_initializers__")
$__dart_deferred_initializers__.current=function(a,b,c,$){var J,A,C,B={NA:function NA(){},aKB:function aKB(d,e){this.a=d
this.b=e},aKC:function aKC(d,e,f){this.a=d
this.b=e
this.c=f},aKD:function aKD(d,e,f,g,h,i,j){var _=this
_.a=d
_.b=e
_.c=f
_.d=g
_.e=h
_.f=i
_.r=j},aKz:function aKz(d,e,f,g,h,i){var _=this
_.a=d
_.b=e
_.c=f
_.d=g
_.e=h
_.f=i},aKA:function aKA(d,e,f){this.a=d
this.b=e
this.c=f},aKE:function aKE(d,e,f){this.a=d
this.b=e
this.c=f},
bbU(d,e){var x
if(e==null)return new self.Blob(d)
x={}
x.type=e
return new self.Blob(d,x)}},D
J=c[1]
A=c[0]
C=c[2]
B=a.updateHolder(c[10],B)
D=c[41]
B.NA.prototype={
vA(d,e,f,g){var x=1000
return this.ahs(d,e,f,g)},
ahs(d,e,f,g){var x=0,w=A.y(y.n),v,u=2,t=[],s=[],r=this,q,p,o
var $async$vA=A.u(function(h,i){if(h===1){t.push(i)
x=u}for(;;)switch(x){case 0:p=1000
o=(self.URL||self.webkitURL).createObjectURL(B.bbU([d],null))
o.toString
q=o
u=3
x=6
return A.p(r.FM(q,p,f,e,g,!0),$async$vA)
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
return A.x($async$vA,w)},
M2(d,e,f,g){return this.aht(d,e,f,g)},
aht(d,e,f,g){var x=0,w=A.y(y.n),v,u=this
var $async$M2=A.u(function(h,i){if(h===1)return A.v(i,w)
for(;;)switch(x){case 0:v=u.auj(d,1000,f,e,g)
x=1
break
case 1:return A.w(v,w)}})
return A.x($async$M2,w)},
FM(d,e,f,g,h,i){return this.auk(d,e,f,g,h,i)},
auj(d,e,f,g,h){return this.FM(d,e,f,g,h,!1)},
auk(d,e,f,g,h,i){var x=0,w=A.y(y.n),v,u,t,s,r,q,p
var $async$FM=A.u(function(j,k){if(j===1)return A.v(k,w)
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
t.a=A.de(D.UP,new B.aKB(r,p))
q=y.c
u=y.F
new A.yH(p,"error",!1,q).gT(0).cq(new B.aKC(t,p,r),u)
new A.yH(p,"loadedmetadata",!1,q).gT(0).cq(new B.aKD(t,r,e,p,f,g,h),u).lU(new B.aKE(t,p,r))
v=s
x=1
break
case 1:return A.w(v,w)}})
return A.x($async$FM,w)}}
var z=a.updateTypes([])
B.aKB.prototype={
$0(){var x=this.a
if((x.a.a&30)===0){C.fD.eH(this.b)
x.da(0,null)}},
$S:0}
B.aKC.prototype={
$1(d){var x=this.a.a
if(x!=null)x.bx(0)
C.fD.eH(this.b)
x=this.c
if((x.a.a&30)===0)x.da(0,null)},
$S:137}
B.aKD.prototype={
$1(d){var x,w,v=this,u=v.b
if((u.a.a&30)!==0)return
x=v.d
w=x.duration
w.toString
x.currentTime=C.d.aY(v.c/1000,0,w)
w=v.a
new A.yH(x,"seeked",!1,y.c).gT(0).cq(new B.aKz(w,u,x,v.e,v.f,v.r),y.F).lU(new B.aKA(w,x,u))},
$S:137}
B.aKz.prototype={
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
if(J.d(w,0)||J.d(v,0)){C.fD.eH(n)
j.da(0,null)
return}u=C.d.aY(k.d/w,0,C.d.aY(k.e/v,0,1/0))
t=C.d.aK(w*u)
s=C.d.aK(v*u)
x.width=t
x.height=s
m=x.getContext("2d")
m.toString
r=m
J.boe(r,n,0,0,t,s)
q=J.bo2(x,"image/jpeg",k.f/100)
p=C.c.gag(J.ala(q,","))
o=C.R1.cn(p)
C.fD.eH(n)
j.da(0,new Uint8Array(A.bD(o)))}catch(l){C.fD.eH(k.c)
j.da(0,null)}},
$S:137}
B.aKA.prototype={
$1(d){var x=this.a.a
if(x!=null)x.bx(0)
C.fD.eH(this.b)
x=this.c
if((x.a.a&30)===0)x.da(0,null)},
$S:13}
B.aKE.prototype={
$1(d){var x=this.a.a
if(x!=null)x.bx(0)
C.fD.eH(this.b)
x=this.c
if((x.a.a&30)===0)x.da(0,null)},
$S:13};(function inheritance(){var x=a.inherit,w=a.inheritMany
x(B.NA,A.D)
x(B.aKB,A.iY)
w(A.eH,[B.aKC,B.aKD,B.aKz,B.aKA,B.aKE])})()
var y={F:A.a_("bB"),i:A.a_("yr"),x:A.a_("bn<eu?>"),c:A.a_("yH<aY>"),m:A.a_("at<eu?>"),n:A.a_("eu?")};(function constants(){D.UP=new A.b3(1e7)})()};
(a=>{a["7F2MESTDbXu6AD6Dpzdc4h3oY+o="]=a.current})($__dart_deferred_initializers__);