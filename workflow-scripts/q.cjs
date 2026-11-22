const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
const rows=db.prepare(process.argv[3]).all();
for(const r of rows) console.log(JSON.stringify(r));
