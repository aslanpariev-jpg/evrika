const finished=t=>['success','failed'].includes(t.result);
const canView=(u,t)=>u.role==='admin'||(!finished(t)&&(t.scope==='common'||String(t.owner_id)===String(u.id)));
const canEdit=(u,t)=>u.role==='admin'||(String(t.owner_id)===String(u.id)&&!finished(t));
const canClaim=(u,t)=>u.role==='employee'&&t.scope==='common'&&!t.owner_id&&!finished(t);
module.exports={finished,canView,canEdit,canClaim};
