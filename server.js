
const express=require("express");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const {Pool}=require("pg");

const app=express();
const PORT=process.env.PORT||3000;
const SECRET=process.env.JWT_SECRET||"CHANGE-ME-XM-MAGAZA-SECRET";
const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!dbUrl && !process.env.PGHOST) {
  throw new Error("DATABASE_URL dəyişəni tapılmadı. Railway-də xm-magaza üçün DATABASE_URL = ${{xm-magaza-db.DATABASE_URL}} əlavə edin.");
}
const pool = dbUrl
  ? new Pool({
      connectionString: dbUrl,
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
    })
  : new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
    });
app.use(express.json({limit:"10mb"}));
app.use(express.static(__dirname+"/public"));

const schema=`
CREATE TABLE IF NOT EXISTS users(
 id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin'
);
CREATE TABLE IF NOT EXISTS categories(
 id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS products(
 id SERIAL PRIMARY KEY, name TEXT NOT NULL, barcode TEXT UNIQUE NOT NULL, code TEXT DEFAULT '',
 category TEXT DEFAULT '', unit TEXT DEFAULT 'ədəd', stock NUMERIC DEFAULT 0, min_stock NUMERIC DEFAULT 0,
 expiry DATE, cost NUMERIC DEFAULT 0, retail NUMERIC DEFAULT 0, wholesale NUMERIC DEFAULT 0,
 vip NUMERIC DEFAULT 0, super_wholesale NUMERIC DEFAULT 0, image TEXT DEFAULT '',
 last_supplier TEXT DEFAULT '', last_purchase_cost NUMERIC DEFAULT 0
);
CREATE TABLE IF NOT EXISTS customers(
 id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '', address TEXT DEFAULT '',
 bonus NUMERIC DEFAULT 0, debt NUMERIC DEFAULT 0
);
CREATE TABLE IF NOT EXISTS customer_payments(
 id SERIAL PRIMARY KEY, customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
 amount NUMERIC NOT NULL, method TEXT DEFAULT 'nağd', date TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS suppliers(
 id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '', address TEXT DEFAULT '', debt NUMERIC DEFAULT 0
);
CREATE TABLE IF NOT EXISTS supplier_purchases(
 id SERIAL PRIMARY KEY, supplier_id INT REFERENCES suppliers(id) ON DELETE CASCADE,
 amount NUMERIC NOT NULL, description TEXT DEFAULT 'Mal alış', date TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS supplier_payments(
 id SERIAL PRIMARY KEY, supplier_id INT REFERENCES suppliers(id) ON DELETE CASCADE,
 amount NUMERIC NOT NULL, date TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sales(
 id SERIAL PRIMARY KEY, customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
 total NUMERIC NOT NULL, paid NUMERIC NOT NULL, debt NUMERIC NOT NULL,
 method TEXT DEFAULT 'nağd', date TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sale_items(
 id SERIAL PRIMARY KEY, sale_id INT REFERENCES sales(id) ON DELETE CASCADE,
 product_id INT REFERENCES products(id) ON DELETE RESTRICT, name TEXT NOT NULL,
 qty NUMERIC NOT NULL, price NUMERIC NOT NULL, level TEXT DEFAULT 'retail', total NUMERIC NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
 id SERIAL PRIMARY KEY, customer_name TEXT DEFAULT '', phone TEXT DEFAULT '', address TEXT DEFAULT '',
 items JSONB NOT NULL DEFAULT '[]', total NUMERIC DEFAULT 0, status TEXT DEFAULT 'Yeni sifariş',
 date TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`;

async function init(){
  await pool.query(schema);
  await pool.query(`INSERT INTO settings(key,value) VALUES('bonusPercent','1') ON CONFLICT(key) DO NOTHING`);
  const u=await pool.query("SELECT id FROM users WHERE username='admin'");
  if(!u.rowCount) await pool.query("INSERT INTO users(username,password,role) VALUES($1,$2,$3)",["admin",await bcrypt.hash(process.env.ADMIN_PASSWORD||"admin123",10),"admin"]);
}
function auth(req,res,next){
  try{
    const h=req.headers.authorization||"";
    req.user=jwt.verify(h.replace("Bearer ",""),SECRET);
    next();
  }catch(e){res.status(401).json({error:"Giriş tələb olunur"});}
}
function n(v){return Number(v||0)}
function price(p,l){return n(p[l==="wholesale"?"wholesale":l==="vip"?"vip":l==="super"?"superWholesale":"retail"])}
async function nextCode(){
  let x=100000;
  while((await pool.query("SELECT 1 FROM products WHERE barcode=$1",[String(x)])).rowCount)x++;
  return String(x);
}

app.get("/api/health",async(q,r)=>r.json({ok:true,service:"XM Mağaza Cloud"}));

app.post("/api/login",async(req,res)=>{
  const u=String(req.body.username||""), p=String(req.body.password||"");
  const z=await pool.query("SELECT * FROM users WHERE username=$1",[u]);
  if(!z.rowCount||!(await bcrypt.compare(p,z.rows[0].password))) return res.status(401).json({error:"İstifadəçi adı və ya şifrə yanlışdır"});
  res.json({token:jwt.sign({id:z.rows[0].id,username:z.rows[0].username,role:z.rows[0].role},SECRET,{expiresIn:"30d"})});
});

app.get("/api/data",auth,async(q,r)=>{
  const [products,categories,customers,suppliers]=await Promise.all([
    pool.query("SELECT id,name,barcode,code,category,unit,stock,min_stock AS \"minStock\",to_char(expiry,'YYYY-MM-DD') AS expiry,cost,retail,wholesale,vip,super_wholesale AS \"superWholesale\",image FROM products ORDER BY id DESC"),
    pool.query("SELECT * FROM categories ORDER BY name"),
    pool.query("SELECT * FROM customers ORDER BY id DESC"),
    pool.query("SELECT * FROM suppliers ORDER BY id DESC")
  ]);
  r.json({products:products.rows,categories:categories.rows,customers:customers.rows,suppliers:suppliers.rows});
});

app.post("/api/products",auth,async(req,res)=>{
  let x=req.body;
  if(!x.name)return res.status(400).json({error:"Məhsul adı yazılmalıdır"});
  const barcode=String(x.barcode||await nextCode());
  try{
    const z=await pool.query(`INSERT INTO products(name,barcode,code,category,unit,stock,min_stock,expiry,cost,retail,wholesale,vip,super_wholesale,image)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,name,barcode,code,category,unit,stock,min_stock AS "minStock",to_char(expiry,'YYYY-MM-DD') AS expiry,cost,retail,wholesale,vip,super_wholesale AS "superWholesale",image`,
      [x.name,barcode,x.code||"",x.category||"",x.unit||"ədəd",n(x.stock),n(x.minStock),x.expiry||null,n(x.cost),n(x.retail),n(x.wholesale),n(x.vip),n(x.superWholesale),x.image||""]);
    res.json(z.rows[0]);
  }catch(e){res.status(400).json({error:e.code==="23505"?"Bu barkod artıq mövcuddur":"Məhsul əlavə edilə bilmədi"});}
});
app.put("/api/products/:id",auth,async(req,res)=>{
  const x=req.body;
  const z=await pool.query(`UPDATE products SET name=COALESCE($1,name),barcode=COALESCE($2,barcode),code=COALESCE($3,code),category=COALESCE($4,category),
    unit=COALESCE($5,unit),stock=COALESCE($6,stock),min_stock=COALESCE($7,min_stock),expiry=$8,cost=COALESCE($9,cost),retail=COALESCE($10,retail),
    wholesale=COALESCE($11,wholesale),vip=COALESCE($12,vip),super_wholesale=COALESCE($13,super_wholesale),image=COALESCE($14,image) WHERE id=$15
    RETURNING id,name,barcode,code,category,unit,stock,min_stock AS "minStock",to_char(expiry,'YYYY-MM-DD') AS expiry,cost,retail,wholesale,vip,super_wholesale AS "superWholesale",image`,
    [x.name,x.barcode,x.code,x.category,x.unit,x.stock===undefined?null:n(x.stock),x.minStock===undefined?null:n(x.minStock),x.expiry||null,x.cost===undefined?null:n(x.cost),x.retail===undefined?null:n(x.retail),x.wholesale===undefined?null:n(x.wholesale),x.vip===undefined?null:n(x.vip),x.superWholesale===undefined?null:n(x.superWholesale),x.image,x.id||req.params.id]);
  if(!z.rowCount)return res.status(404).json({error:"Məhsul yoxdur"});res.json(z.rows[0]);
});
app.delete("/api/products/:id",auth,async(req,res)=>{try{await pool.query("DELETE FROM products WHERE id=$1",[req.params.id]);res.json({ok:true})}catch(e){res.status(400).json({error:"Bu məhsul satış tarixçəsində istifadə olunub və silinə bilmir"})}});

app.post("/api/stock",auth,async(req,res)=>{
  const p=await pool.query("SELECT * FROM products WHERE id=$1",[req.body.productId]);
  const q=n(req.body.quantity); if(!p.rowCount||q<=0)return res.status(400).json({error:"Məlumat düzgün deyil"});
  const z=await pool.query(`UPDATE products SET stock=stock+$1,last_supplier=$2,last_purchase_cost=$3,cost=$3 WHERE id=$4 RETURNING id,name,stock,cost`,
    [q,req.body.supplier||"",n(req.body.cost),req.body.productId]);res.json(z.rows[0]);
});

app.post("/api/customers",auth,async(req,res)=>{
  const z=await pool.query("INSERT INTO customers(name,phone,address) VALUES($1,$2,$3) RETURNING *",[req.body.name,req.body.phone||"",req.body.address||""]);
  res.json(z.rows[0]);
});
app.post("/api/customers/:id/pay",auth,async(req,res)=>{
  const a=n(req.body.amount); if(a<=0)return res.status(400).json({error:"Məbləğ düzgün deyil"});
  const c=await pool.query("SELECT * FROM customers WHERE id=$1",[req.params.id]); if(!c.rowCount)return res.status(404).json({error:"Müştəri yoxdur"});
  await pool.query("UPDATE customers SET debt=GREATEST(0,debt-$1) WHERE id=$2",[a,req.params.id]);
  await pool.query("INSERT INTO customer_payments(customer_id,amount,method) VALUES($1,$2,$3)",[req.params.id,a,req.body.method||"nağd"]);
  res.json((await pool.query("SELECT * FROM customers WHERE id=$1",[req.params.id])).rows[0]);
});
app.get("/api/customers/:id/history",auth,async(req,res)=>{
  const [sales,payments]=await Promise.all([
    pool.query("SELECT * FROM sales WHERE customer_id=$1 ORDER BY date DESC",[req.params.id]),
    pool.query("SELECT * FROM customer_payments WHERE customer_id=$1 ORDER BY date DESC",[req.params.id])
  ]);res.json({sales:sales.rows,payments:payments.rows});
});

app.post("/api/suppliers",auth,async(req,res)=>{
  const z=await pool.query("INSERT INTO suppliers(name,phone,address) VALUES($1,$2,$3) RETURNING *",[req.body.name,req.body.phone||"",req.body.address||""]);res.json(z.rows[0]);
});
app.post("/api/suppliers/:id/purchase",auth,async(req,res)=>{
  const a=n(req.body.amount); if(a<=0)return res.status(400).json({error:"Məbləğ düzgün deyil"});
  await pool.query("UPDATE suppliers SET debt=debt+$1 WHERE id=$2",[a,req.params.id]);
  await pool.query("INSERT INTO supplier_purchases(supplier_id,amount,description) VALUES($1,$2,$3)",[req.params.id,a,req.body.description||"Mal alış"]);
  res.json((await pool.query("SELECT * FROM suppliers WHERE id=$1",[req.params.id])).rows[0]);
});
app.post("/api/suppliers/:id/pay",auth,async(req,res)=>{
  const a=n(req.body.amount); if(a<=0)return res.status(400).json({error:"Məbləğ düzgün deyil"});
  await pool.query("UPDATE suppliers SET debt=GREATEST(0,debt-$1) WHERE id=$2",[a,req.params.id]);
  await pool.query("INSERT INTO supplier_payments(supplier_id,amount) VALUES($1,$2)",[req.params.id,a]);
  res.json((await pool.query("SELECT * FROM suppliers WHERE id=$1",[req.params.id])).rows[0]);
});
app.get("/api/suppliers/:id/history",auth,async(req,res)=>{
  const [p,pa]=await Promise.all([
    pool.query("SELECT * FROM supplier_purchases WHERE supplier_id=$1 ORDER BY date DESC",[req.params.id]),
    pool.query("SELECT * FROM supplier_payments WHERE supplier_id=$1 ORDER BY date DESC",[req.params.id])
  ]);res.json({purchases:p.rows,payments:pa.rows});
});

app.post("/api/sales",auth,async(req,res)=>{
  const items=req.body.items||[];
  if(!items.length)return res.status(400).json({error:"Səbət boşdur"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    let total=0, rows=[];
    for(const x of items){
      const p=(await client.query("SELECT * FROM products WHERE id=$1 FOR UPDATE",[x.productId])).rows[0];
      const qty=n(x.qty), pr=n(x.price);
      if(!p||qty<=0||n(p.stock)<qty)throw new Error(`${p?.name||"Məhsul"} üçün stok kifayət etmir`);
      total+=qty*pr; rows.push({p,qty,price:pr,level:x.level||"retail"});
    }
    const paid=Math.min(total,Math.max(0,n(req.body.paid))), debt=total-paid;
    let customer=null;
    if(req.body.customerId) customer=(await client.query("SELECT * FROM customers WHERE id=$1 FOR UPDATE",[req.body.customerId])).rows[0];
    if(!customer&&debt>0)throw new Error("Müştəri seçilməyibsə satış tam ödənilməlidir");
    const sale=(await client.query("INSERT INTO sales(customer_id,total,paid,debt,method) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [customer?.id||null,total,paid,debt,req.body.method||"nağd"])).rows[0];
    for(const x of rows){
      await client.query("UPDATE products SET stock=stock-$1 WHERE id=$2",[x.qty,x.p.id]);
      await client.query("INSERT INTO sale_items(sale_id,product_id,name,qty,price,level,total) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [sale.id,x.p.id,x.p.name,x.qty,x.price,x.level,x.qty*x.price]);
    }
    if(customer){
      const bp=n((await client.query("SELECT value FROM settings WHERE key='bonusPercent'")).rows[0]?.value||1);
      await client.query("UPDATE customers SET debt=debt+$1,bonus=bonus+$2 WHERE id=$3",[debt,total*bp/100,customer.id]);
    }
    await client.query("COMMIT");
    res.json({...sale,items:rows.map(x=>({productId:x.p.id,name:x.p.name,qty:x.qty,price:x.price,level:x.level,total:x.qty*x.price}))});
  }catch(e){await client.query("ROLLBACK");res.status(400).json({error:e.message});}finally{client.release();}
});

app.get("/api/stats",auth,async(req,res)=>{
  const s=await pool.query("SELECT COALESCE(SUM(total),0) total,COALESCE(SUM(paid),0) paid,COALESCE(SUM(debt),0) debt,COUNT(*) count FROM sales");
  const p=await pool.query(`SELECT si.name,SUM(si.qty) qty,SUM(si.total) revenue,SUM(si.qty*(si.price-p.cost)) profit
    FROM sale_items si JOIN products p ON p.id=si.product_id GROUP BY si.name ORDER BY revenue DESC`);
  res.json({...s.rows[0],products:p.rows});
});

app.get("/api/orders",auth,async(req,res)=>{const z=await pool.query("SELECT id,customer_name AS customer,phone,address,items,total,status,date FROM orders ORDER BY date DESC");res.json(z.rows)});
app.post("/api/orders",async(req,res)=>{
  const c=req.body.customer||{};
  const z=await pool.query("INSERT INTO orders(customer_name,phone,address,items,total,status) VALUES($1,$2,$3,$4,$5,'Yeni sifariş') RETURNING *",
    [c.name||"",c.phone||"",c.address||"",JSON.stringify(req.body.items||[]),n(req.body.total)]);
  res.json({ok:true,order:z.rows[0]});
});
app.put("/api/orders/:id",auth,async(req,res)=>{
  const z=await pool.query("UPDATE orders SET status=$1 WHERE id=$2 RETURNING *",[req.body.status,req.params.id]);
  if(!z.rowCount)return res.status(404).json({error:"Sifariş yoxdur"});res.json(z.rows[0]);
});
app.get("/api/shop/products",async(req,res)=>{
  const z=await pool.query(`SELECT id,name,barcode,retail AS price,unit,stock,image,category FROM products WHERE stock>0 ORDER BY name`);
  res.json(z.rows);
});
app.get("/api/labels",auth,async(req,res)=>{const z=await pool.query("SELECT * FROM products ORDER BY name");res.json(z.rows)});
app.get("/api/alerts",auth,async(req,res)=>{
  const z=await pool.query(`SELECT id,name,barcode,stock,min_stock AS "minStock",to_char(expiry,'YYYY-MM-DD') expiry
    FROM products WHERE stock<=min_stock OR (expiry IS NOT NULL AND expiry<=CURRENT_DATE+INTERVAL '14 days') ORDER BY expiry NULLS LAST`);
  res.json(z.rows);
});

app.get("/shop",(q,r)=>r.sendFile(__dirname+"/public/shop.html"));
app.get("*",(q,r)=>r.sendFile(__dirname+"/public/index.html"));

init().then(()=>app.listen(PORT,"0.0.0.0",()=>console.log("XM Mağaza Cloud port "+PORT)))
.catch(e=>{console.error(e);process.exit(1)});
