const BASE='https://jwglxt.sdust.edu.cn';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
class Jar{constructor(){this.m=new Map()}absorb(r){for(const sc of(r.headers.getSetCookie?.()||[])){const[p]=sc.split(';');const i=p.indexOf('=');this.m.set(p.slice(0,i).trim(),p.slice(i+1).trim())}}h(){return[...this.m].map(([k,v])=>`${k}=${v}`).join('; ')}}
async function req(jar,url,o={}){const r=await fetch(url,{redirect:'manual',...o,headers:{'User-Agent':UA,'Referer':BASE+'/',...(jar?{Cookie:jar.h()}:{}),...(o.headers||{})}});if(jar)jar.absorb(r);return{r,body:await r.text()}}
function enc(scode,sxh,a,p,d=' '){const c=`${a}%%%${p}%%%${d}`;let rest=scode,out='';for(let i=0;i<c.length;i++){if(i<55){out+=c[i]+rest.slice(0,+sxh[i]);rest=rest.slice(+sxh[i])}else{out+=c.slice(i);break}}return out}
const msg=b=>b.match(/id="showMsg">([^<]*)</)?.[1]??'(none)';

for (const variant of ['valid-encoded-no-userAccount','garbage-no-userAccount','valid-encoded-with-userAccount','garbage-with-userAccount']) {
  const jar=new Jar(); await req(jar,BASE+'/');
  const s=await req(jar,BASE+'/Logon.do?method=logon&flag=sess',{method:'POST'});
  const [sc,sx]=s.body.split('#');
  const account='202000000000';
  const garbage=variant.includes('garbage');
  const form=new URLSearchParams({loginMethod:'logon',userlanguage:'0',userPassword:'',encoded:garbage?'garbage':enc(sc,sx,account,'somepassword')});
  if(!variant.includes('no-userAccount')) form.set('userAccount',account);
  const r=await req(jar,BASE+'/Logon.do?method=logon',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  console.log(variant.padEnd(34),'->',r.r.status,JSON.stringify(msg(r.body)));
}
