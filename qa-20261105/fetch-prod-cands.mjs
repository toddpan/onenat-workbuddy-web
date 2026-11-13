(async () => {
const BASE='http://127.0.0.1:3081/onenat-workbuddy';
const login=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'workbuddy',password:'ThunderSoft@88'})});
const tok=/wb_session=([^;]+)/.exec(login.headers.getSetCookie().join(';'))[1];
const j=await (await fetch(BASE+'/api/mentions/candidates',{headers:{Cookie:'wb_session='+tok}})).json();
require('fs').writeFileSync('/tmp/prod-cands.json', JSON.stringify(j.data));
console.log('saved', j.data.length);
})();
