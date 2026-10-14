-- =====================================================================

--  SWAMY FOODS - DATABASE SELF-TEST

--

--  Run AFTER schema.sql:  SQL Editor -> New query -> paste -> Run.

--

--  It creates fake users, a fake product and fake orders, tries to break

--  the rules from every role (guest, customer, admin), checks stock in

--  BOTH modes, and then ALWAYS rolls everything back - nothing is saved.

--

--  A PASS looks like an error:

--        ERROR:  ALL NN CHECKS PASSED (everything was rolled back)

--  A failure says:   TEST FAILED: <what went wrong>

-- =====================================================================


 

create or replace function pg_temp.as_postgres() returns void language plpgsql as $$

begin

  reset role;

end $$;


 

create or replace function pg_temp.as_anon() returns void language plpgsql as $$

begin

  reset role;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  perform set_config('request.jwt.claim.sub', '', true);

  set local role anon;

end $$;


 

create or replace function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$

begin

  reset role;

  perform set_config('request.jwt.claims',

                     json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);

  perform set_config('request.jwt.claim.sub', p_uid::text, true);

  set local role authenticated;

end $$;


 

create or replace function pg_temp.ok(p_cond boolean, p_label text) returns void language plpgsql as $$

begin

  if p_cond is not true then

    raise exception 'TEST FAILED: %', p_label;

  end if;

  perform set_config('selftest.count',

    (coalesce(nullif(current_setting('selftest.count', true), ''), '0')::integer + 1)::text, true);

end $$;


 

-- the statement MUST fail, and the error must contain p_expect

create or replace function pg_temp.must_fail(p_sql text, p_expect text) returns void language plpgsql as $$

begin

  begin

    execute p_sql;

  exception when others then

    if position(lower(p_expect) in lower(sqlerrm)) = 0 then

      raise exception 'TEST FAILED: expected an error containing "%" but got "%" -- %', p_expect, sqlerrm, p_sql;

    end if;

    perform pg_temp.ok(true, p_sql);

    return;

  end;

  raise exception 'TEST FAILED: this should have been refused ("%") but it worked -- %', p_expect, p_sql;

end $$;


 

do $$

declare

  admin_id uuid := gen_random_uuid();

  a_id     uuid := gen_random_uuid();

  b_id     uuid := gen_random_uuid();

  pid      uuid;

  vid      uuid;   -- tracked size  (stock 10, $10.00)

  vid2     uuid;   -- made-to-order size ($18.50, blank stock)

  res      jsonb;

  res2     jsonb;

  oid1     uuid;

  oid2     uuid;

  n        integer;

  n0       integer;

  pfx      text;

  oid3     uuid;

  oid4     uuid;

  oid5     uuid;

  oid6     uuid;

  lid      text;

  s0       integer;

  ctr      integer;

  cust     jsonb := jsonb_build_object(

             'name','Test Buyer','email','buyer@example.com','phone','0400 000 000',

             'address_line1','1 Test St','suburb','Cranbourne North','state','VIC','postcode','3977');

begin

  ---------------------------------------------------------------- setup

  insert into auth.users (id, email) values

    (admin_id, 'selftest-admin@example.com'),

    (a_id,     'selftest-a@example.com'),

    (b_id,     'selftest-b@example.com');

  insert into public.admins (user_id) values (admin_id);


 

  perform pg_temp.ok((select count(*) from public.profiles where id in (a_id, b_id)) = 2,

                     'sign-up trigger creates a profile row');


 

  perform pg_temp.as_user(admin_id);

  res := public.admin_save_product(jsonb_build_object(

    'name','ZZ Selftest Product','category','spices','variants', jsonb_build_array(

      jsonb_build_object('weight','100 gm','price','10.00','stock','10'),

      jsonb_build_object('weight','200 gm','price','18.50','stock',''))));

  pid := (res ->> 'id')::uuid;

  perform public.admin_save_settings('{"stock_mode":"on_submit"}'::jsonb);


 

  perform pg_temp.as_postgres();

  select id into vid  from public.product_variants where product_id = pid and weight = '100 gm';

  select id into vid2 from public.product_variants where product_id = pid and weight = '200 gm';


 

  ---------------------------------------------------------------- A. tables are locked

  perform pg_temp.as_anon();

  perform pg_temp.must_fail('select * from public.orders',           'permission denied');

  perform pg_temp.must_fail('select * from public.product_variants', 'permission denied');

  perform pg_temp.must_fail('select * from public.settings',         'permission denied');

  perform pg_temp.must_fail('select * from public.admins',           'permission denied');

  perform pg_temp.must_fail('insert into public.orders (ref) values (''X'')', 'permission denied');

  perform pg_temp.as_user(a_id);

  perform pg_temp.must_fail('select * from public.orders',           'permission denied');

  perform pg_temp.must_fail(format('insert into public.admins (user_id) values (%L)', a_id), 'permission denied');

  perform pg_temp.must_fail('update public.product_variants set price = 0', 'permission denied');


 

  ---------------------------------------------------------------- B. functions are locked

  perform pg_temp.as_anon();

  perform pg_temp.must_fail('select public.admin_list_orders()', 'permission denied');

  perform pg_temp.must_fail('select public.my_orders()',         'permission denied');

  perform pg_temp.must_fail('select public._deduct_stock(gen_random_uuid())', 'permission denied');

  perform pg_temp.ok(public.is_admin() = false, 'guest is not an admin');

  perform pg_temp.as_user(a_id);

  perform pg_temp.must_fail('select public.admin_list_orders()', 'not allowed');

  perform pg_temp.must_fail('select public.admin_get_settings()', 'not allowed');

  perform pg_temp.must_fail(format('select public.admin_set_order_status(%L, ''paid'')', gen_random_uuid()), 'not allowed');

  perform pg_temp.must_fail('select public.admin_save_product(''{"name":"x","category":"spices","variants":[{"weight":"1","price":"1"}]}''::jsonb)', 'not allowed');

  perform pg_temp.ok(public.is_admin() = false, 'normal customer is not an admin');

  perform pg_temp.as_user(admin_id);

  perform pg_temp.ok(public.is_admin() = true, 'admin is an admin');


 

  ---------------------------------------------------------------- C. public catalog

  perform pg_temp.as_anon();

  perform pg_temp.ok(jsonb_array_length(public.get_catalog()) >= 1, 'guest can read the catalog');

  perform pg_temp.ok(position('ZZ Selftest Product' in public.get_catalog()::text) > 0, 'new product is in catalog');


 

  ---------------------------------------------------------------- D. guest checkout, stock mode = on_submit

  res := public.place_order(cust, jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 3)));

  perform pg_temp.ok((res ->> 'total')::numeric = 30.00, 'total is calculated on the server (3 x 10.00)');

  perform pg_temp.ok((res ->> 'ref') ~ '^SF-[A-Z0-9]{6}$', 'order reference looks right');

  perform pg_temp.ok((res ->> 'status') = 'submitted', 'new order is "submitted"');

  oid1 := (res ->> 'id')::uuid;

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 7, 'on_submit: stock 10 -> 7');

  perform pg_temp.ok((select user_id from public.orders where id = oid1) is null, 'guest order has no user');


 

  -- tampering

  perform pg_temp.as_anon();

  res2 := public.place_order(cust, jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 1, 'price', 0.01, 'unit_price', 0.01)));

  perform pg_temp.ok((res2 ->> 'total')::numeric = 10.00, 'a price sent by the browser is ignored');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust,

            jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 50))), 'only');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust,

            jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 0))), 'invalid item');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust,

            jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', -2))), 'invalid item');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust,

            jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 'abc'))), 'invalid item');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust,

            jsonb_build_array(jsonb_build_object('variant_id', 'not-a-uuid', 'qty', 1))), 'invalid item');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust, '[]'), 'empty');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust,

            jsonb_build_array(jsonb_build_object('variant_id', gen_random_uuid(), 'qty', 1))), 'no longer available');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust || '{"email":"nope"}',

            jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 1))), 'valid email');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust || '{"postcode":"39"}',

            jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 1))), 'postcode');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust || '{"phone":"12"}',

            jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 1))), 'phone');

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust || '{"state":"XX"}',

            jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 1))), 'state');


 

  -- made-to-order size: unlimited, never touches stock

  res2 := public.place_order(cust, jsonb_build_array(jsonb_build_object('variant_id', vid2, 'qty', 40)));

  perform pg_temp.ok((res2 ->> 'total')::numeric = 740.00, 'made-to-order size: 40 x 18.50');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid2) is null, 'made-to-order stays untracked');

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 6, 'stock is 6 after 3 + 1 ordered');


 

  -- spam brake: 5 orders per email per hour (3 placed above for buyer@example.com)

  perform pg_temp.as_anon();

  perform public.place_order(cust, jsonb_build_array(jsonb_build_object('variant_id', vid2, 'qty', 1)));

  perform public.place_order(cust, jsonb_build_array(jsonb_build_object('variant_id', vid2, 'qty', 1)));

  perform pg_temp.must_fail(format('select public.place_order(%L::jsonb, %L::jsonb)', cust,

            jsonb_build_array(jsonb_build_object('variant_id', vid2, 'qty', 1))), 'several orders');


 

  ---------------------------------------------------------------- E. guest tracking

  perform pg_temp.as_anon();

  res2 := public.track_order(lower(res ->> 'ref'), ' BUYER@example.com ');

  perform pg_temp.ok((res2 ->> 'ref') = (res ->> 'ref'), 'track_order ignores case / spaces');

  perform pg_temp.ok(not (res2 ? 'admin_note') and not (res2 ? 'stock_deducted'), 'guest never sees admin-only fields');

  perform pg_temp.must_fail(format('select public.track_order(%L, ''someone@else.com'')', res ->> 'ref'), 'could not find');

  perform pg_temp.must_fail('select public.track_order(''SF-ZZZZZZ'', ''buyer@example.com'')', 'could not find');


 

  ---------------------------------------------------------------- F. logged-in customers only see their own orders

  perform pg_temp.as_user(a_id);

  res2 := public.place_order(cust || '{"email":"a-customer@example.com"}', jsonb_build_array(jsonb_build_object('variant_id', vid2, 'qty', 2)));

  perform pg_temp.ok(jsonb_array_length(public.my_orders()) = 1, 'customer A sees exactly 1 order');

  perform pg_temp.as_user(b_id);

  perform pg_temp.ok(jsonb_array_length(public.my_orders()) = 0, 'customer B sees none of A''s orders');

  perform pg_temp.as_user(a_id);

  perform public.save_my_profile('{"full_name":"A Person","suburb":"Cranbourne North","state":"vic","postcode":"3977"}'::jsonb);

  perform pg_temp.ok((public.get_my_profile() ->> 'state') = 'VIC', 'profile saved (state upper-cased)');

  perform pg_temp.as_user(b_id);

  perform pg_temp.ok((public.get_my_profile() ->> 'full_name') is distinct from 'A Person', 'B cannot see A''s profile');


 

  ---------------------------------------------------------------- G. admin: status changes and stock (mode on_submit)

  perform pg_temp.as_user(admin_id);

  perform pg_temp.ok(jsonb_array_length(public.admin_list_orders()) >= 5, 'admin sees all orders');

  res := public.admin_set_order_status(oid1, 'cancelled');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 9, 'cancel puts 3 back (6 -> 9)');

  perform pg_temp.as_user(admin_id);

  res := public.admin_set_order_status(oid1, 'confirmed');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 6, 're-confirm takes 3 out again (9 -> 6)');

  perform pg_temp.as_user(admin_id);

  res := public.admin_set_order_status(oid1, 'invoiced');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 6, 'confirm -> invoiced does not double-deduct');

  perform pg_temp.as_user(admin_id);

  perform pg_temp.must_fail('select public.admin_set_order_status(gen_random_uuid(), ''bogus'')', 'unknown status');


 

  ---------------------------------------------------------------- H. stock mode = on_confirm

  perform public.admin_save_settings('{"stock_mode":"on_confirm"}'::jsonb);

  -- reset the tracked size to exactly 5

  perform public.admin_save_product(jsonb_build_object(

    'id', pid, 'name','ZZ Selftest Product','category','spices','variants', jsonb_build_array(

      jsonb_build_object('id', vid,  'weight','100 gm','price','10.00','stock','5'),

      jsonb_build_object('id', vid2, 'weight','200 gm','price','18.50','stock',''))));

  perform pg_temp.as_anon();

  res  := public.place_order(cust || '{"email":"c1@example.com"}', jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 4)));

  res2 := public.place_order(cust || '{"email":"c2@example.com"}', jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 4)));

  oid1 := (res ->> 'id')::uuid;

  oid2 := (res2 ->> 'id')::uuid;

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 5, 'on_confirm: submitting does NOT change stock');

  perform pg_temp.ok((select stock_deducted from public.orders where id = oid1) = false, 'on_confirm: order is not holding stock');


 

  perform pg_temp.as_user(admin_id);

  perform public.admin_set_order_status(oid1, 'confirmed');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 1, 'on_confirm: confirming takes 4 out (5 -> 1)');

  perform pg_temp.as_user(admin_id);

  perform pg_temp.must_fail(format('select public.admin_set_order_status(%L, ''confirmed'')', oid2), 'not enough stock');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select status from public.orders where id = oid2) = 'submitted', 'failed confirm leaves the order untouched');

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 1, 'failed confirm leaves stock untouched');


 

  ---------------------------------------------------------------- I. admin edits an order

  perform pg_temp.as_user(admin_id);

  res := public.admin_get_order(oid2);

  perform pg_temp.ok((res -> 'items' -> 0 ->> 'stock')::integer = 1, 'admin sees live stock beside each line');

  res := public.admin_update_order(oid2, jsonb_build_array(jsonb_build_object('id', res -> 'items' -> 0 ->> 'id', 'qty', 1)), 15, 2.5, 'short stock, sent 1');

  perform pg_temp.ok((res ->> 'subtotal')::numeric = 10.00, 'edit: subtotal 1 x 10.00');

  perform pg_temp.ok((res ->> 'total')::numeric = 22.50,    'edit: 10.00 - 2.50 discount + 15.00 shipping');

  perform pg_temp.ok((res ->> 'admin_note') = 'short stock, sent 1', 'admin note saved');

  res := public.admin_set_order_status(oid2, 'confirmed');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 0, 'edited order now confirms (1 -> 0)');

  perform pg_temp.as_user(admin_id);

  res := public.admin_get_order(oid2);

  perform pg_temp.must_fail(format('select public.admin_update_order(%L, %L::jsonb, 0, 0, null)', oid2,

            jsonb_build_array(jsonb_build_object('id', res -> 'items' -> 0 ->> 'id', 'qty', 2))), 'not enough stock');

  res := public.admin_get_order(oid1);

  res := public.admin_update_order(oid1, jsonb_build_array(jsonb_build_object('id', res -> 'items' -> 0 ->> 'id', 'qty', 2)), 0, 0, null);

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 2, 'lowering a confirmed order returns stock (0 -> 2)');

  perform pg_temp.as_user(admin_id);

  perform pg_temp.must_fail(format('select public.admin_update_order(%L, ''[]''::jsonb, -5, 0, null)', oid1), 'delivery');

  perform pg_temp.must_fail(format('select public.admin_update_order(%L, %L::jsonb, 0, 0, null)', oid1,

            jsonb_build_array(jsonb_build_object('id', (public.admin_get_order(oid1) -> 'items' -> 0 ->> 'id'), 'qty', 0))), 'at least one item');


 

  ---------------------------------------------------------------- J. invoices

  n0  := coalesce((public.admin_get_settings() ->> 'invoice_counter')::integer, 0);

  pfx := coalesce(nullif(public.admin_get_settings() ->> 'invoice_prefix', ''), 'SF-');

  res  := public.admin_issue_invoice(oid1);

  res2 := public.admin_issue_invoice(oid2);

  perform pg_temp.ok((res ->> 'invoice_no')  = pfx || lpad((n0 + 1)::text, 5, '0'), 'next invoice number is issued');

  perform pg_temp.ok((res2 ->> 'invoice_no') = pfx || lpad((n0 + 2)::text, 5, '0'), 'numbers go up by one, no gaps');

  perform pg_temp.ok((public.admin_issue_invoice(oid1) ->> 'invoice_no') = (res ->> 'invoice_no'), 'invoice number never changes');

  perform pg_temp.ok((res ->> 'status') = 'invoiced', 'issuing moves order to "invoiced"');

  res := public.admin_set_order_status(oid2, 'paid');

  perform pg_temp.must_fail(format('select public.admin_update_order(%L, ''[]''::jsonb, 0, 0, null)', oid2), 'can no longer be edited');

  res := public.admin_set_order_status(oid1, 'cancelled');

  perform pg_temp.must_fail(format('select public.admin_issue_invoice(%L)', oid1) , 'cancelled');


 

  ---------------------------------------------------------------- L. deleting orders

  perform pg_temp.as_user(admin_id);

  perform public.admin_save_settings('{"stock_mode":"on_submit"}'::jsonb);

  perform public.admin_save_product(jsonb_build_object(

    'id', pid, 'name','ZZ Selftest Product','category','spices','variants', jsonb_build_array(

      jsonb_build_object('id', vid,  'weight','100 gm','price','10.00','stock','6'),

      jsonb_build_object('id', vid2, 'weight','200 gm','price','18.50','stock',''))));

  perform pg_temp.as_anon();

  res := public.place_order(cust || '{"email":"del1@example.com"}', jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 2)));

  oid3 := (res ->> 'id')::uuid;

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 4, 'delete tests: the order holds 2 (6 -> 4)');

  perform pg_temp.as_anon();

  perform pg_temp.must_fail(format('select public.admin_delete_order(%L, ''X'')', oid3), 'permission denied');

  perform pg_temp.as_user(a_id);

  perform pg_temp.must_fail(format('select public.admin_delete_order(%L, %L)', oid3, res ->> 'ref'), 'not allowed');

  perform pg_temp.as_user(admin_id);

  perform pg_temp.must_fail(format('select public.admin_delete_order(%L, ''SF-WRONG1'')', oid3), 'did not match');

  perform pg_temp.must_fail(format('select public.admin_delete_order(%L, %L)', gen_random_uuid(), res ->> 'ref'), 'order not found');

  perform pg_temp.as_postgres();

  perform pg_temp.ok(exists (select 1 from public.orders where id = oid3), 'a refused delete leaves the order in place');

  perform pg_temp.as_user(admin_id);

  res2 := public.admin_delete_order(oid3, lower(res ->> 'ref'));

  perform pg_temp.ok((res2 ->> 'stock_restored')::boolean = true, 'delete reports that stock was put back (a lower-case reference is accepted)');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select count(*) from public.orders where id = oid3) = 0 and (select count(*) from public.order_items where order_id = oid3) = 0, 'the order and its items are gone');

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 6, 'deleting an order that held stock puts it back (4 -> 6)');

  perform pg_temp.ok((select count(*) from public.order_deletions where ref = res ->> 'ref') = 1, 'a small record of the deletion is kept');

  perform pg_temp.as_anon();

  perform pg_temp.must_fail(format('select public.track_order(%L, ''del1@example.com'')', res ->> 'ref'), 'could not find');


 

  res := public.place_order(cust || '{"email":"del2@example.com"}', jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 1)));

  oid4 := (res ->> 'id')::uuid;

  perform pg_temp.as_user(admin_id);

  perform public.admin_set_order_status(oid4, 'cancelled');

  perform pg_temp.as_postgres();

  s0 := (select stock_qty from public.product_variants where id = vid);

  perform pg_temp.as_user(admin_id);

  res2 := public.admin_delete_order(oid4, res ->> 'ref');

  perform pg_temp.ok((res2 ->> 'stock_restored')::boolean = false, 'a cancelled order holds no stock, so none is put back');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = s0 and s0 = 6, 'stock is unchanged when a cancelled order is deleted');


 

  perform pg_temp.as_anon();

  res := public.place_order(cust || '{"email":"del3@example.com"}', jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 1)));

  oid5 := (res ->> 'id')::uuid;

  perform pg_temp.as_user(admin_id);

  perform public.admin_issue_invoice(oid5);

  ctr := (public.admin_get_settings() ->> 'invoice_counter')::integer;

  res2 := public.admin_delete_order(oid5, res ->> 'ref');

  perform pg_temp.ok((res2 ->> 'invoice_no') is not null, 'deleting an invoiced order reports the invoice number it removed');

  perform pg_temp.ok((public.admin_get_settings() ->> 'invoice_counter')::integer = ctr, 'invoice numbers are never reused (the counter does not go back)');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select count(*) from public.order_deletions where invoice_no = res2 ->> 'invoice_no') = 1, 'the kept record includes the invoice number');

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 6, 'stock is back to 6 after deleting an invoiced order');

  perform pg_temp.as_user(admin_id);

  perform public.admin_save_settings('{"stock_mode":"on_confirm"}'::jsonb);


 

  ---------------------------------------------------------------- M. adding and removing products on an order

  perform pg_temp.as_user(admin_id);

  perform public.admin_save_settings('{"stock_mode":"on_submit"}'::jsonb);

  perform pg_temp.as_anon();

  res := public.place_order(cust || '{"email":"edit1@example.com"}', jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 1)));

  oid6 := (res ->> 'id')::uuid;

  perform pg_temp.as_user(admin_id);

  res2 := public.admin_update_order(oid6, jsonb_build_array(jsonb_build_object('variant_id', vid2, 'qty', 2)), 0, 0, null);

  perform pg_temp.ok(jsonb_array_length(res2 -> 'items') = 2, 'adding a product creates a new line');

  perform pg_temp.ok((res2 ->> 'subtotal')::numeric = 47.00, 'subtotal is now 10.00 + 2 x 18.50 = 47.00');

  res2 := public.admin_update_order(oid6, jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 2)), 0, 0, null);

  perform pg_temp.ok(jsonb_array_length(res2 -> 'items') = 2, 'adding a size that is already on the order merges into the same line');

  perform pg_temp.ok((select qty from public.order_items where order_id = oid6 and variant_id = vid) = 3, 'the merged line now has quantity 3');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 3, 'stock followed the added quantity (5 -> 3)');

  perform pg_temp.as_user(admin_id);

  perform pg_temp.must_fail(format('select public.admin_update_order(%L, %L::jsonb, 0, 0, null)', oid6,

            jsonb_build_array(jsonb_build_object('variant_id', vid, 'qty', 9))), 'not enough stock');

  perform pg_temp.must_fail(format('select public.admin_update_order(%L, %L::jsonb, 0, 0, null)', oid6,

            jsonb_build_array(jsonb_build_object('variant_id', gen_random_uuid(), 'qty', 1))), 'no longer exists');

  perform pg_temp.must_fail(format('select public.admin_update_order(%L, %L::jsonb, 0, 0, null)', oid6,

            jsonb_build_array(jsonb_build_object('variant_id', vid2, 'qty', 0))), 'invalid item');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 3, 'refused additions changed nothing');

  perform pg_temp.as_user(a_id);

  perform pg_temp.must_fail(format('select public.admin_update_order(%L, %L::jsonb, 0, 0, null)', oid6,

            jsonb_build_array(jsonb_build_object('variant_id', vid2, 'qty', 1))), 'not allowed');

  perform pg_temp.as_user(admin_id);

  res2 := public.admin_get_order(oid6);

  lid := (select e ->> 'id' from jsonb_array_elements(res2 -> 'items') e where e ->> 'weight' = '100 gm');

  res2 := public.admin_update_order(oid6, jsonb_build_array(jsonb_build_object('id', lid, 'qty', 0)), 0, 0, null);

  perform pg_temp.ok(jsonb_array_length(res2 -> 'items') = 1, 'setting a line to 0 removes it');

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select stock_qty from public.product_variants where id = vid) = 6, 'removing a line puts its stock back (3 -> 6)');

  perform pg_temp.as_user(admin_id);

  res2 := public.admin_get_order(oid6);

  lid := (res2 -> 'items' -> 0 ->> 'id');

  perform pg_temp.must_fail(format('select public.admin_update_order(%L, %L::jsonb, 0, 0, null)', oid6,

            jsonb_build_array(jsonb_build_object('id', lid, 'qty', 0))), 'at least one item');

  perform public.admin_save_settings('{"stock_mode":"on_confirm"}'::jsonb);


 

  ---------------------------------------------------------------- K. product / settings admin

  perform pg_temp.must_fail('select public.admin_save_product(''{"name":"","category":"spices","variants":[{"weight":"1","price":"1"}]}''::jsonb)', 'product name');

  perform pg_temp.must_fail('select public.admin_save_product(''{"name":"x","category":"nope","variants":[{"weight":"1","price":"1"}]}''::jsonb)', 'category');

  perform pg_temp.must_fail('select public.admin_save_product(''{"name":"x","category":"spices","variants":[]}''::jsonb)', 'at least one size');

  perform pg_temp.must_fail('select public.admin_save_product(''{"name":"x","category":"spices","variants":[{"weight":"1 kg","price":"-3"}]}''::jsonb)', 'valid price');

  perform pg_temp.must_fail('select public.admin_save_product(''{"name":"x","category":"spices","variants":[{"weight":"1 kg","price":"3"},{"weight":"1 kg","price":"4"}]}''::jsonb)', 'same weight');

  perform pg_temp.must_fail('select public.admin_save_settings(''{"stock_mode":"whenever"}''::jsonb)', 'invalid stock mode');

  perform pg_temp.ok((public.admin_get_settings() ->> 'stock_mode') = 'on_confirm', 'stock mode setting is saved');

  perform public.admin_delete_product(pid);

  perform pg_temp.ok(position('ZZ Selftest Product' in public.admin_get_catalog()::text) = 0, 'deleted product is gone');


 

  perform pg_temp.as_postgres();

  perform pg_temp.ok((select count(*) from public.order_items where product_name = 'ZZ Selftest Product') > 0,

                     'old orders keep their item lines after a product is deleted');


 

  ---------------------------------------------------------------- done: ALWAYS roll back

  n := coalesce(nullif(current_setting('selftest.count', true), ''), '0')::integer;

  raise exception 'ALL % CHECKS PASSED (everything was rolled back, nothing was saved)', n;

end $$;


 
