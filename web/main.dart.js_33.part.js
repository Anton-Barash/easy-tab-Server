((a,b)=>{a[b]=a[b]||{}})(self,"$__dart_deferred_initializers__")
$__dart_deferred_initializers__.current=function(a,b,c,$){var J,A,C,B={
bjz(a3){var x,w,v,u,t,s,r,q,p,o,n,m,l,k,j,i,h,g,f,e,d,a0,a1=A.b([],y.X),a2=a3.b
for(x=a3.d,w=J.cv(a2),v=y.N,u=y.p,t=0;t<x.length;++t){s=A.t(v,u)
for(r=w.gV(a2),q=0;r.p();){p=r.gJ(r)
o=a3.mD(t,p)
s.l(0,p,o)
n=o.length
if(n>q)q=n}for(r=w.gV(a2),m=q;r.p();){p=r.gJ(r)
if(s.h(0,p).length<m)m=s.h(0,p).length}l=q!==m||q===0
k=!1
if(l)for(r=w.gV(a2);r.p();){p=r.gJ(r)
for(j=m;j<s.h(0,p).length;++j){i=A.b2(J.i(s.h(0,p)[j],"text"))
if((i==null?"":i).length!==0){k=!0
break}}if(k)break}if(l)h=k
else{g=s.h(0,w.gT(a2))
f=0
for(;;){if(!(f<g.length)){h=!1
break}for(r=w.gV(a2),e=!1,d=!1;r.p();){o=s.h(0,r.gJ(r))
if(f<o.length){a0=A.b2(J.i(o[f],"text"))
if((a0==null?"":a0).length===0)e=!0
else d=!0}}if(e&&d){h=!0
break}++f}}if(h)a1.push(t)}return a1},
bCB(a3){var x,w,v,u,t,s,r,q,p,o,n,m,l,k,j,i,h,g,f,e,d,a0,a1,a2=B.bjz(a3)
if(a2.length===0)return"{}"
x=a3.b
w=y.t
v=y.N
u=y.z
t=A.Z(["languages",x,"questions",A.b([],w)],v,u)
for(s=a2.length,r=J.cv(x),q=y.S,p=a3.d,o=y.E,n=y.j,m=y.K,l=0;l<a2.length;a2.length===s||(0,A.H)(a2),++l){k=a2[l]
j=p[k]
i=A.b([],o)
for(h=r.gV(x);h.p();){g=a3.mD(k,h.gJ(h))
for(f=0;f<g.length;++f){if(f>=i.length)i.push(A.b([],q))
e=J.i(g[f],"text")
if(e==null)e=""
i[f].push(e)}}d=A.b([],w)
for(a0=0;a0<i.length;++a0){a1=i[a0]
if(C.c.hp(a1,new B.b3U()))d.push(A.Z(["id",a0,"variants",a1],v,u))}if(d.length!==0)J.cQ(n.a(t.h(0,"questions")),A.Z(["id",j.a,"answers",d],v,m))}return A.aUO(t,null,"  ")},
bEa(a1){var x,w,v,u,t,s,r,q,p,o,n,m,l,k,j,i,h,g,f=null,e="languages",d="questions",a0="variants"
try{x=y.P.a(C.b5.ua(0,a1,f))
if(!J.fy(x,e))return f
if(!J.fy(x,d))return f
w=J.i(x,e)
l=y.j
if(!l.b(w))return f
if(J.fz(w)||J.aT(w)>32)return f
for(k=J.aP(w);k.p();){v=k.gJ(k)
if(typeof v!="string"||v.length===0)return f}u=J.m9(w,y.N)
t=J.i(x,d)
if(!l.b(t))return f
if(J.aT(t)>2000)return f
for(k=J.aP(t),j=y.f;k.p();){s=k.gJ(k)
if(!j.b(s))return f
r=J.i(s,"id")
if(!A.hT(r))return f
if(!J.fy(s,"answers"))return f
q=J.i(s,"answers")
if(!l.b(q))return f
if(J.aT(q)>2000)return f
for(i=J.aP(q);i.p();){p=i.gJ(i)
if(!j.b(p))return f
o=J.i(p,"id")
if(!A.hT(o))return f
if(!J.fy(p,a0))return f
n=J.i(p,a0)
if(!l.b(n))return f
if(J.aT(n)!==J.aT(u))return f
for(h=J.aP(n);h.p();){m=h.gJ(h)
if(typeof m!="string")return f
if(m.length>5e4)return f}}}return x}catch(g){return f}},
bB4(b8,b9){var x,w,v,u,t,s,r,q,p,o,n,m,l,k,j,i,h,g,f,e,d,a0,a1,a2,a3,a4,a5,a6,a7,a8,a9,b0,b1,b2,b3,b4,b5,b6,b7=B.bEa(b9)
if(b7==null)return!1
x=J.ae(b7)
w=y.j
v=y.N
u=J.m9(w.a(x.h(b7,"languages")),v)
t=b8.b
for(x=J.aP(w.a(x.h(b7,"questions"))),s=y.s,r=J.cv(t),q=y.T,p=y.a,o=y.J,n=y.y,m=y.u,l=b8.d,k=y.C,j=y.x;x.p();){i=x.gJ(x)
h=J.ae(i)
g=A.c2(h.h(i,"id"))
f=w.a(h.h(i,"answers"))
e=C.c.adI(l,new B.b3j(g))
if(e===-1)continue
d=C.b.j(e)
a0=A.b([],m)
a1=b8.f.h(0,d)
if(a1==null)a1=A.b([],k)
for(h=J.ae(a1),a2=0;a2<h.gn(a1);++a2)a0.push(h.h(a1,a2).a)
a3=a0.length
a4=A.b_(a3,!1,!1,n)
for(a5=a0.length,a2=0;a2<a3;++a2)if(a2<a5&&a0[a2])a4[a2]=!0
a6=A.b([],o)
for(a2=0;a2<h.gn(a1);++a2)a6.push(A.es(h.h(a1,a2).b,!0,p))
if(!b8.e.aj(0,d))b8.e.l(0,d,A.t(v,j))
for(h=r.gV(t);h.p();){a5=h.gJ(h)
a7=b8.e.h(0,d)
a7.toString
if(!J.fy(a7,a5)){a7=b8.e.h(0,d)
a7.toString
J.bl(a7,a5,A.b([],q))}}for(h=J.cv(f),a5=h.gV(f);a5.p();){a8=a5.gJ(a5)
a7=J.ae(a8)
a9=A.c2(a7.h(a8,"id"))
b0=J.m9(w.a(a7.h(a8,"variants")),v)
for(a7=r.gV(t);a7.p();){b1=a7.gJ(a7)
b2=u.dh(u,b1)
if(b2===-1)continue
b3=b2<b0.gn(b0)?b0.h(0,b2):""
b4=b8.e.h(0,d)
b4.toString
b1=J.i(b4,b1)
b1.toString
if(b3.length===0)continue
b4=J.ae(b1)
if(a9<b4.gn(b1))b4.l(b1,a9,new A.dN(b3,!1))
else{while(b4.gn(b1)<a9)b4.A(b1,new A.dN("",!0))
b4.A(b1,new A.dN(b3,!1))}}}if(!b8.f.aj(0,d))b8.f.l(0,d,A.b([],k))
for(h=h.gV(f);h.p();){a9=A.c2(J.i(h.gJ(h),"id"))
b5=a9<a3&&a4[a9]
b6=A.b([],s)
if(a9<a6.length)b6=a6[a9]
a5=b8.f.h(0,d)
a5.toString
a5=J.aT(a5)
a7=b8.f
if(a9<a5){a5=a7.h(0,d)
a5.toString
J.i(a5,a9).a=b5
a5=b8.f.h(0,d)
a5.toString
J.i(a5,a9).b=b6}else{a5=a7.h(0,d)
a5.toString
J.cQ(a5,new A.em(b5,b6,!1))}}}return!0},
b3U:function b3U(){},
b3j:function b3j(d){this.a=d}}
J=c[1]
A=c[0]
C=c[2]
B=a.updateHolder(c[11],B)
var z=a.updateTypes([])
B.b3U.prototype={
$1(d){return d.length!==0},
$S:20}
B.b3j.prototype={
$1(d){return d.a===this.a},
$S:666};(function inheritance(){var x=a.inheritMany
x(A.f_,[B.b3U,B.b3j])})()
var y=(function rtii(){var x=A.a_
return{C:x("r<em>"),J:x("r<A<i2>>"),E:x("r<A<f>>"),t:x("r<ad<f,@>>"),s:x("r<i2>"),S:x("r<f>"),T:x("r<dN>"),u:x("r<P>"),X:x("r<l>"),p:x("A<ad<f,@>>"),x:x("A<dN>"),j:x("A<@>"),P:x("ad<f,@>"),f:x("ad<@,@>"),a:x("i2"),K:x("D"),N:x("f"),y:x("P"),z:x("@")}})()};
(a=>{a["06O90KcKO275FKqIyqQyXeWpVS0="]=a.current})($__dart_deferred_initializers__);