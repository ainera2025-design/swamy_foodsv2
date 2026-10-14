-- =====================================================================

--  SWAMY FOODS  -  DATABASE SETUP FOR SUPABASE

--

--  HOW TO RUN

--    Supabase dashboard -> SQL Editor -> New query -> paste this whole

--    file -> Run.  It is safe to run again later (it will not delete

--    your orders, and the sample products are only added to an empty

--    products table).

--

--  HOW IT IS PROTECTED (the short version)

--    * Every table is locked.  The website can NOT read or write tables

--      directly.  It can only call the functions at the bottom of this

--      file, and each function checks who is calling and validates

--      everything.

--    * Prices are always read from the products table on the server.

--      The browser only says "variant X, quantity 2" - it can never set

--      a price.

--    * Admin functions check the caller is listed in the "admins" table.

--      Nobody can add themselves to that table from the website.

-- =====================================================================



 

-- ---------------------------------------------------------------------

-- 1. TABLES

-- ---------------------------------------------------------------------


 

create table if not exists public.products (

  id          uuid primary key default gen_random_uuid(),

  name        text not null check (char_length(name) between 1 and 120),

  category    text not null check (category in ('spices', 'appalam')),

  note        text check (note is null or char_length(note) <= 200),

  image       text check (image is null or image ~ '^[A-Za-z0-9._-]+\.png$'),

  sort_order  integer not null default 0,

  active      boolean not null default true,

  created_at  timestamptz not null default now()

);


 

-- One row per pack size.  stock_qty NULL = made to order / not tracked.

create table if not exists public.product_variants (

  id          uuid primary key default gen_random_uuid(),

  product_id  uuid not null references public.products(id) on delete cascade,

  weight      text not null check (char_length(weight) between 1 and 40),

  price       numeric(10,2) not null check (price >= 0),

  stock_qty   integer check (stock_qty is null or stock_qty >= 0),

  active      boolean not null default true,

  sort_order  integer not null default 0,

  unique (product_id, weight)

);


 

create table if not exists public.profiles (

  id             uuid primary key references auth.users(id) on delete cascade,

  full_name      text,

  phone          text,

  address_line1  text,

  address_line2  text,

  suburb         text,

  state          text,

  postcode       text,

  updated_at     timestamptz not null default now()

);


 

-- Who is an admin.  Only filled in by you, in the SQL editor (see README).

create table if not exists public.admins (

  user_id     uuid primary key references auth.users(id) on delete cascade,

  created_at  timestamptz not null default now()

);


 

create table if not exists public.settings (

  key    text primary key,

  value  jsonb not null

);


 

create table if not exists public.orders (

  id                 uuid primary key default gen_random_uuid(),

  ref                text not null unique,

  user_id            uuid references auth.users(id) on delete set null,

  status             text not null default 'submitted'

                     check (status in ('submitted','confirmed','invoiced','paid','shipped','cancelled')),

  customer_name      text not null,

  customer_email     text not null,

  customer_phone     text not null,

  address_line1      text not null,

  address_line2      text,

  suburb             text not null,

  state              text not null,

  postcode           text not null,

  customer_note      text,

  subtotal           numeric(10,2) not null default 0,

  discount           numeric(10,2) not null default 0,

  shipping_fee       numeric(10,2) not null default 0,

  total              numeric(10,2) not null default 0,

  admin_note         text,

  stock_deducted     boolean not null default false,

  invoice_no         text unique,

  invoice_issued_at  timestamptz,

  created_at         timestamptz not null default now(),

  updated_at         timestamptz not null default now()

);

create index if not exists orders_user_idx    on public.orders (user_id);

create index if not exists orders_created_idx on public.orders (created_at desc);

create index if not exists orders_email_idx   on public.orders (lower(customer_email));


 

-- Name, weight and price are copied into the order, so changing a price

-- later never changes an old order or invoice.

create table if not exists public.order_items (

  id            uuid primary key default gen_random_uuid(),

  order_id      uuid not null references public.orders(id) on delete cascade,

  line_no       integer not null,

  variant_id    uuid references public.product_variants(id) on delete set null,

  product_name  text not null,

  weight        text not null,

  unit_price    numeric(10,2) not null check (unit_price >= 0),

  qty           integer not null check (qty > 0),

  line_total    numeric(10,2) not null

);

create index if not exists order_items_order_idx on public.order_items (order_id);


 

-- When an admin deletes an order, one small line is kept here (no customer details), so a gap in the

-- invoice numbers can always be explained later.

create table if not exists public.order_deletions (

  id           uuid primary key default gen_random_uuid(),

  ref          text not null,

  invoice_no   text,

  status       text,

  total        numeric(10,2),

  items_count  integer,

  deleted_by   uuid,

  deleted_at   timestamptz not null default now()

);



 

-- ---------------------------------------------------------------------

-- 2. LOCK EVERY TABLE

--    Row level security ON + no policies + no grants = the website

--    cannot touch tables directly.  Only the functions below can.

-- ---------------------------------------------------------------------


 

alter table public.products          enable row level security;

alter table public.product_variants  enable row level security;

alter table public.profiles          enable row level security;

alter table public.admins            enable row level security;

alter table public.settings          enable row level security;

alter table public.orders            enable row level security;

alter table public.order_items       enable row level security;


 

alter table public.order_deletions   enable row level security;


 

revoke all on public.products, public.product_variants, public.profiles,

              public.admins, public.settings, public.orders, public.order_items,

              public.order_deletions

  from anon, authenticated;



 

-- ---------------------------------------------------------------------

-- 3. INTERNAL HELPERS (not callable from the website)

-- ---------------------------------------------------------------------


 

create or replace function public.is_admin()

returns boolean

language sql stable security definer set search_path = public

as $$

  select exists (select 1 from public.admins a where a.user_id = auth.uid());

$$;


 

create or replace function public._require_admin()

returns void

language plpgsql security definer set search_path = public

as $$

begin

  if not public.is_admin() then

    raise exception 'Not allowed.' using errcode = '42501';

  end if;

end $$;


 

-- 'on_submit'  = stock goes down the moment a customer submits an order

-- 'on_confirm' = stock goes down only when you confirm / invoice the order

create or replace function public._stock_mode()

returns text

language sql stable security definer set search_path = public

as $$

  select coalesce((select s.value #>> '{}' from public.settings s where s.key = 'stock_mode'), 'on_submit');

$$;


 

create or replace function public._random_code(n integer)

returns text

language plpgsql volatile

as $$

declare

  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- no 0/O/1/I to avoid mix-ups

  out   text := '';

  i     integer;

begin

  for i in 1..n loop

    out := out || substr(chars, 1 + floor(random() * 32)::integer, 1);

  end loop;

  return out;

end $$;


 

-- Order as JSON.  p_admin = true adds internal fields and live stock.

-- (Deliberately VOLATILE so it always sees changes made earlier in the

--  same transaction.)

create or replace function public._order_json(p_id uuid, p_admin boolean default false)

returns jsonb

language sql security definer set search_path = public

as $$

  select jsonb_build_object(

      'id', o.id,

      'ref', o.ref,

      'status', o.status,

      'created_at', o.created_at,

      'customer', jsonb_build_object(

        'name', o.customer_name, 'email', o.customer_email, 'phone', o.customer_phone,

        'address_line1', o.address_line1, 'address_line2', o.address_line2,

        'suburb', o.suburb, 'state', o.state, 'postcode', o.postcode),

      'customer_note', o.customer_note,

      'subtotal', o.subtotal, 'discount', o.discount,

      'shipping_fee', o.shipping_fee, 'total', o.total,

      'invoice_no', o.invoice_no, 'invoice_issued_at', o.invoice_issued_at,

      'items', (

        select coalesce(jsonb_agg(

                 jsonb_build_object(

                   'id', i.id, 'variant_id', i.variant_id,

                   'name', i.product_name, 'weight', i.weight,

                   'unit_price', i.unit_price, 'qty', i.qty, 'line_total', i.line_total)

                 || case when p_admin

                         then jsonb_build_object('stock', v.stock_qty)

                         else '{}'::jsonb end

                 order by i.line_no), '[]'::jsonb)

        from public.order_items i

        left join public.product_variants v on v.id = i.variant_id

        where i.order_id = o.id)

    )

    || case when p_admin

            then jsonb_build_object('admin_note', o.admin_note,

                                    'stock_deducted', o.stock_deducted,

                                    'has_account', o.user_id is not null)

            else '{}'::jsonb end

  from public.orders o

  where o.id = p_id;

$$;


 

create or replace function public._catalog_json(p_admin boolean)

returns jsonb

language sql stable security definer set search_path = public

as $$

  select coalesce(jsonb_agg(

    jsonb_build_object(

      'id', p.id, 'name', p.name, 'category', p.category,

      'note', p.note, 'image', p.image,

      'sort_order', p.sort_order, 'active', p.active,

      'variants', (

        select coalesce(jsonb_agg(

                 jsonb_build_object('id', v.id, 'weight', v.weight, 'price', v.price,

                                    'stock', v.stock_qty, 'active', v.active,

                                    'sort_order', v.sort_order)

                 order by v.sort_order, v.price, v.weight), '[]'::jsonb)

        from public.product_variants v

        where v.product_id = p.id and (p_admin or v.active))

    ) order by p.sort_order, p.name), '[]'::jsonb)

  from public.products p

  where (p_admin or p.active)

    and (p_admin or exists (select 1 from public.product_variants v2

                            where v2.product_id = p.id and v2.active));

$$;


 

-- Take an order's quantities OUT of stock (tracked items only).

create or replace function public._deduct_stock(p_order uuid)

returns void

language plpgsql security definer set search_path = public

as $$

declare

  r record;

begin

  for r in

    select i.qty, v.id as vid, v.stock_qty, i.product_name, i.weight

      from public.order_items i

      join public.product_variants v on v.id = i.variant_id

     where i.order_id = p_order and v.stock_qty is not null

     order by v.id

       for update of v

  loop

    if r.qty > r.stock_qty then

      raise exception 'Not enough stock for % (%): % needed, % in stock.',

        r.product_name, r.weight, r.qty, r.stock_qty;

    end if;

    update public.product_variants set stock_qty = stock_qty - r.qty where id = r.vid;

  end loop;

  update public.orders set stock_deducted = true where id = p_order;

end $$;


 

-- Put an order's quantities BACK into stock (tracked items only).

create or replace function public._restore_stock(p_order uuid)

returns void

language plpgsql security definer set search_path = public

as $$

begin

  update public.product_variants v

     set stock_qty = v.stock_qty + i.qty

    from public.order_items i

   where i.order_id = p_order

     and v.id = i.variant_id

     and v.stock_qty is not null;

  update public.orders set stock_deducted = false where id = p_order;

end $$;


 

-- ONE rule decides stock for every status change:

--   cancelled                 -> stock must NOT be held

--   submitted (new)           -> held only if the mode is 'on_submit'

--   confirmed/invoiced/paid/shipped -> stock must be held

create or replace function public._sync_stock(p_order uuid, p_status text)

returns void

language plpgsql security definer set search_path = public

as $$

declare

  v_deducted boolean;

  v_want     boolean;

begin

  select stock_deducted into v_deducted from public.orders where id = p_order;

  v_want := case p_status

              when 'cancelled' then false

              when 'submitted' then (public._stock_mode() = 'on_submit')

              else true

            end;

  if v_want and not v_deducted then

    perform public._deduct_stock(p_order);

  elsif (not v_want) and v_deducted then

    perform public._restore_stock(p_order);

  end if;

end $$;



 

-- ---------------------------------------------------------------------

-- 4. NEW-USER PROFILE

-- ---------------------------------------------------------------------


 

create or replace function public.handle_new_user()

returns trigger

language plpgsql security definer set search_path = public

as $$

begin

  insert into public.profiles (id, full_name)

  values (new.id, nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 100), ''))

  on conflict (id) do nothing;

  return new;

end $$;


 

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created

  after insert on auth.users

  for each row execute function public.handle_new_user();



 

-- ---------------------------------------------------------------------

-- 5. PUBLIC FUNCTIONS (customers and guests)

-- ---------------------------------------------------------------------


 

create or replace function public.get_catalog()

returns jsonb

language sql stable security definer set search_path = public

as $$

  select public._catalog_json(false);

$$;


 

-- Places an order.  Works for guests AND logged-in customers.

-- p_customer: {name,email,phone,address_line1,address_line2,suburb,state,postcode,note}

-- p_items   : [{variant_id, qty}, ...]      (no prices - they are looked up here)

create or replace function public.place_order(p_customer jsonb, p_items jsonb)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  v_uid       uuid := auth.uid();

  v_name      text := btrim(coalesce(p_customer ->> 'name', ''));

  v_email     text := lower(btrim(coalesce(p_customer ->> 'email', '')));

  v_phone     text := btrim(coalesce(p_customer ->> 'phone', ''));

  v_addr1     text := btrim(coalesce(p_customer ->> 'address_line1', ''));

  v_addr2     text := nullif(btrim(coalesce(p_customer ->> 'address_line2', '')), '');

  v_suburb    text := btrim(coalesce(p_customer ->> 'suburb', ''));

  v_state     text := upper(btrim(coalesce(p_customer ->> 'state', '')));

  v_postcode  text := btrim(coalesce(p_customer ->> 'postcode', ''));

  v_note      text := nullif(btrim(coalesce(p_customer ->> 'note', '')), '');

  v_mode      text := public._stock_mode();

  v_order_id  uuid;

  v_ref       text;

  v_subtotal  numeric(10,2) := 0;

  v_line_no   integer := 0;

  v_recent    integer;

  r           record;

  s           record;

begin

  -- ---- customer details ----

  if char_length(v_name) < 2 or char_length(v_name) > 100 then

    raise exception 'Please enter your full name.';

  end if;

  if char_length(v_email) > 254

     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then

    raise exception 'Please enter a valid email address.';

  end if;

  if v_phone !~ '^[0-9+() -]{8,20}$'

     or char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 8 then

    raise exception 'Please enter a valid phone number.';

  end if;

  if char_length(v_addr1) < 3 or char_length(v_addr1) > 120 then

    raise exception 'Please enter your street address.';

  end if;

  if v_addr2 is not null and char_length(v_addr2) > 120 then

    raise exception 'Address line 2 is too long.';

  end if;

  if char_length(v_suburb) < 2 or char_length(v_suburb) > 60 then

    raise exception 'Please enter your suburb.';

  end if;

  if v_state not in ('VIC','NSW','QLD','SA','WA','TAS','ACT','NT') then

    raise exception 'Please choose your state.';

  end if;

  if v_postcode !~ '^[0-9]{4}$' then

    raise exception 'Please enter a 4-digit postcode.';

  end if;

  if v_note is not null and char_length(v_note) > 500 then

    raise exception 'Your note is too long (500 characters maximum).';

  end if;


 

  -- ---- cart shape ----

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then

    raise exception 'Your cart is empty.';

  end if;

  if jsonb_array_length(p_items) > 60 then

    raise exception 'Too many items in one order. Please split it into two orders.';

  end if;

  if exists (

    select 1

      from jsonb_array_elements(p_items) e

     where jsonb_typeof(e) <> 'object'

        or coalesce(e ->> 'variant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

        or coalesce(e ->> 'qty', '') !~ '^[0-9]{1,3}$'

        or (case when coalesce(e ->> 'qty', '') ~ '^[0-9]{1,3}$' then (e ->> 'qty')::integer else 0 end) < 1

  ) then

    raise exception 'Your cart has an invalid item. Please refresh the page and try again.';

  end if;


 

  -- ---- simple spam brake ----

  select count(*) into v_recent

    from public.orders

   where lower(customer_email) = v_email

     and created_at > now() - interval '1 hour';

  if v_recent >= 5 then

    raise exception 'We have received several orders from this email in the last hour. Please contact us directly to add more.';

  end if;


 

  -- ---- create the order ----

  loop

    v_ref := 'SF-' || public._random_code(6);

    exit when not exists (select 1 from public.orders where ref = v_ref);

  end loop;


 

  insert into public.orders

    (ref, user_id, customer_name, customer_email, customer_phone,

     address_line1, address_line2, suburb, state, postcode, customer_note)

  values

    (v_ref, v_uid, v_name, v_email, v_phone,

     v_addr1, v_addr2, v_suburb, v_state, v_postcode, v_note)

  returning id into v_order_id;


 

  -- ---- items: price + stock come from the database, never the browser ----

  for r in

    select (e ->> 'variant_id')::uuid as variant_id,

           sum((e ->> 'qty')::integer)::integer as qty

      from jsonb_array_elements(p_items) e

     group by 1

     order by 1

  loop

    if r.qty > 99 then

      raise exception 'You can order up to 99 of each item online. Please contact us for larger orders.';

    end if;


 

    select v.id, v.weight, v.price, v.stock_qty, p.name as pname

      into s

      from public.product_variants v

      join public.products p on p.id = v.product_id

     where v.id = r.variant_id and v.active and p.active

       for update of v;


 

    if not found then

      raise exception 'An item in your cart is no longer available. Please refresh the page and review your cart.';

    end if;


 

    if s.stock_qty is not null and r.qty > s.stock_qty then

      if s.stock_qty = 0 then

        raise exception '% (%) is out of stock.', s.pname, s.weight;

      end if;

      raise exception 'Only % left of % (%). Please reduce the quantity.', s.stock_qty, s.pname, s.weight;

    end if;


 

    v_line_no := v_line_no + 1;

    insert into public.order_items

      (order_id, line_no, variant_id, product_name, weight, unit_price, qty, line_total)

    values

      (v_order_id, v_line_no, s.id, s.pname, s.weight, s.price, r.qty, round(s.price * r.qty, 2));

    v_subtotal := v_subtotal + round(s.price * r.qty, 2);


 

    if v_mode = 'on_submit' and s.stock_qty is not null then

      update public.product_variants set stock_qty = stock_qty - r.qty where id = s.id;

    end if;

  end loop;


 

  update public.orders

     set subtotal = v_subtotal,

         total = v_subtotal,

         stock_deducted = (v_mode = 'on_submit')

   where id = v_order_id;


 

  return public._order_json(v_order_id, false);

end $$;


 

-- Guests can check an order with its reference AND the email used.

create or replace function public.track_order(p_ref text, p_email text)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  v_id uuid;

begin

  select o.id into v_id

    from public.orders o

   where o.ref = upper(btrim(coalesce(p_ref, '')))

     and lower(o.customer_email) = lower(btrim(coalesce(p_email, '')));

  if v_id is null then

    raise exception 'We could not find an order with that reference and email.';

  end if;

  return public._order_json(v_id, false);

end $$;



 

-- ---------------------------------------------------------------------

-- 6. LOGGED-IN CUSTOMER FUNCTIONS

-- ---------------------------------------------------------------------


 

create or replace function public.get_my_profile()

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  v_uid uuid := auth.uid();

  v     jsonb;

begin

  if v_uid is null then

    raise exception 'Please log in first.';

  end if;

  select to_jsonb(p) - 'id' - 'updated_at' into v from public.profiles p where p.id = v_uid;

  return coalesce(v, '{}'::jsonb);

end $$;


 

create or replace function public.save_my_profile(p jsonb)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  v_uid uuid := auth.uid();

begin

  if v_uid is null then

    raise exception 'Please log in first.';

  end if;

  insert into public.profiles

    (id, full_name, phone, address_line1, address_line2, suburb, state, postcode, updated_at)

  values (

    v_uid,

    nullif(left(btrim(coalesce(p ->> 'full_name', '')), 100), ''),

    nullif(left(btrim(coalesce(p ->> 'phone', '')), 20), ''),

    nullif(left(btrim(coalesce(p ->> 'address_line1', '')), 120), ''),

    nullif(left(btrim(coalesce(p ->> 'address_line2', '')), 120), ''),

    nullif(left(btrim(coalesce(p ->> 'suburb', '')), 60), ''),

    nullif(left(upper(btrim(coalesce(p ->> 'state', ''))), 3), ''),

    nullif(left(btrim(coalesce(p ->> 'postcode', '')), 4), ''),

    now())

  on conflict (id) do update set

    full_name = excluded.full_name, phone = excluded.phone,

    address_line1 = excluded.address_line1, address_line2 = excluded.address_line2,

    suburb = excluded.suburb, state = excluded.state, postcode = excluded.postcode,

    updated_at = now();

  return public.get_my_profile();

end $$;


 

create or replace function public.my_orders()

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  v_uid uuid := auth.uid();

begin

  if v_uid is null then

    raise exception 'Please log in to see your orders.';

  end if;

  return coalesce((

    select jsonb_agg(public._order_json(x.id, false) order by x.created_at desc)

      from (select id, created_at from public.orders

             where user_id = v_uid

             order by created_at desc limit 100) x

  ), '[]'::jsonb);

end $$;



 

-- ---------------------------------------------------------------------

-- 7. ADMIN FUNCTIONS (every one starts with _require_admin)

-- ---------------------------------------------------------------------


 

create or replace function public.admin_list_orders()

returns jsonb

language plpgsql security definer set search_path = public

as $$

begin

  perform public._require_admin();

  return coalesce((

    select jsonb_agg(x.j order by x.created_at desc)

      from (

        select o.created_at,

               jsonb_build_object(

                 'id', o.id, 'ref', o.ref, 'status', o.status, 'created_at', o.created_at,

                 'customer_name', o.customer_name, 'customer_email', o.customer_email,

                 'customer_phone', o.customer_phone,

                 'suburb', o.suburb, 'state', o.state, 'postcode', o.postcode,

                 'total', o.total, 'invoice_no', o.invoice_no,

                 'items_count', coalesce((select sum(i.qty) from public.order_items i

                                           where i.order_id = o.id), 0)) as j

          from public.orders o

         order by o.created_at desc

         limit 500) x

  ), '[]'::jsonb);

end $$;


 

create or replace function public.admin_get_order(p_id uuid)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  v jsonb;

begin

  perform public._require_admin();

  v := public._order_json(p_id, true);

  if v is null then

    raise exception 'Order not found.';

  end if;

  return v;

end $$;


 

create or replace function public.admin_set_order_status(p_order_id uuid, p_status text)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  o public.orders%rowtype;

begin

  perform public._require_admin();

  if p_status is null

     or p_status not in ('submitted','confirmed','invoiced','paid','shipped','cancelled') then

    raise exception 'Unknown status.';

  end if;

  select * into o from public.orders where id = p_order_id for update;

  if not found then

    raise exception 'Order not found.';

  end if;

  if o.status <> p_status then

    perform public._sync_stock(p_order_id, p_status);   -- may refuse if stock is short

    update public.orders set status = p_status, updated_at = now() where id = p_order_id;

  end if;

  return public._order_json(p_order_id, true);

end $$;


 

-- Change quantities (0 removes a line), ADD products, and set shipping, discount and your note.

-- p_items: [{id: <order line id>, qty: n}, ...]   change or remove (0) an existing line

--          [{variant_id: <size id>, qty: n}, ...]   add a product (merges into the line if it is already on the order)

create or replace function public.admin_update_order(

  p_order_id uuid, p_items jsonb, p_shipping numeric, p_discount numeric, p_note text)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  o       public.orders%rowtype;

  it      public.order_items%rowtype;

  r       record;

  cur     integer;

  v_new   integer;

  v_delta integer;

  nv      record;

  v_sub   numeric(10,2);

  v_ship  numeric(10,2) := round(coalesce(p_shipping, 0), 2);

  v_disc  numeric(10,2) := round(coalesce(p_discount, 0), 2);

begin

  perform public._require_admin();

  select * into o from public.orders where id = p_order_id for update;

  if not found then

    raise exception 'Order not found.';

  end if;

  if o.status in ('paid','shipped','cancelled') then

    raise exception 'This order is % and can no longer be edited. Move it back to Confirmed or Invoiced first if you really need to change it.', o.status;

  end if;

  if v_ship < 0 or v_ship > 1000 then

    raise exception 'Delivery must be between $0 and $1000.';

  end if;

  if v_disc < 0 then

    raise exception 'Discount cannot be negative.';

  end if;

  if p_items is not null and jsonb_typeof(p_items) <> 'array' then

    raise exception 'Invalid items.';

  end if;


 

  for r in

    select e ->> 'id' as id_txt, e ->> 'variant_id' as vid_txt, e ->> 'qty' as qty_txt

      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e

  loop

    -- ---- ADD a product to the order ----

    if coalesce(r.id_txt, '') = '' and coalesce(r.vid_txt, '') <> '' then

      if r.vid_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

         or coalesce(r.qty_txt, '') !~ '^[0-9]{1,3}$'

         or (case when coalesce(r.qty_txt, '') ~ '^[0-9]{1,3}$' then r.qty_txt::integer else 0 end) < 1 then

        raise exception 'Invalid item quantity.';

      end if;

      v_new := r.qty_txt::integer;


 

      select v.id, v.weight, v.price, v.stock_qty, p.name as pname

        into nv

        from public.product_variants v

        join public.products p on p.id = v.product_id

       where v.id = r.vid_txt::uuid

         for update of v;

      if not found then

        raise exception 'That product or size no longer exists.';

      end if;


 

      -- if this order already holds stock, the new quantity must come off the shelf too

      if o.stock_deducted and nv.stock_qty is not null then

        if v_new > nv.stock_qty then

          raise exception 'Not enough stock for % (%): % more needed but only % in stock.',

            nv.pname, nv.weight, v_new, nv.stock_qty;

        end if;

        update public.product_variants set stock_qty = stock_qty - v_new where id = nv.id;

      end if;


 

      select * into it from public.order_items where order_id = p_order_id and variant_id = nv.id;

      if found then

        -- already on the order: add to that line (it keeps the price the customer was shown)

        update public.order_items

           set qty = it.qty + v_new, line_total = round(unit_price * (it.qty + v_new), 2)

         where id = it.id;

      else

        insert into public.order_items

          (order_id, line_no, variant_id, product_name, weight, unit_price, qty, line_total)

        values

          (p_order_id,

           coalesce((select max(i.line_no) from public.order_items i where i.order_id = p_order_id), 0) + 1,

           nv.id, nv.pname, nv.weight, nv.price, v_new, round(nv.price * v_new, 2));

      end if;

      continue;

    end if;


 

    -- ---- change or remove an existing line ----

    if coalesce(r.id_txt, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

       or coalesce(r.qty_txt, '') !~ '^[0-9]{1,3}$' then

      raise exception 'Invalid item quantity.';

    end if;


 

    select * into it from public.order_items

     where id = r.id_txt::uuid and order_id = p_order_id;

    if not found then

      raise exception 'Order line not found.';

    end if;


 

    v_new   := r.qty_txt::integer;

    v_delta := v_new - it.qty;


 

    if v_delta <> 0 then

      -- if this order is already holding stock, keep the shelf count in step

      if o.stock_deducted and it.variant_id is not null then

        select stock_qty into cur from public.product_variants

         where id = it.variant_id for update;

        if cur is not null then

          if v_delta > cur then

            raise exception 'Not enough stock for % (%): % more needed but only % in stock.',

              it.product_name, it.weight, v_delta, cur;

          end if;

          update public.product_variants set stock_qty = cur - v_delta where id = it.variant_id;

        end if;

      end if;

      if v_new = 0 then

        delete from public.order_items where id = it.id;

      else

        update public.order_items

           set qty = v_new, line_total = round(unit_price * v_new, 2)

         where id = it.id;

      end if;

    end if;

  end loop;


 

  if not exists (select 1 from public.order_items where order_id = p_order_id) then

    raise exception 'An order needs at least one item. Cancel the order instead.';

  end if;


 

  select coalesce(sum(line_total), 0) into v_sub from public.order_items where order_id = p_order_id;

  if v_disc > v_sub then

    v_disc := v_sub;

  end if;


 

  update public.orders

     set subtotal = v_sub,

         discount = v_disc,

         shipping_fee = v_ship,

         total = v_sub - v_disc + v_ship,

         admin_note = nullif(left(btrim(coalesce(p_note, '')), 1000), ''),

         updated_at = now()

   where id = p_order_id;


 

  return public._order_json(p_order_id, true);

end $$;


 

-- Gives the order its invoice number (once, never changes) and moves a new

-- or confirmed order to "invoiced".  The invoice itself is printed from the

-- admin page.

create or replace function public.admin_issue_invoice(p_order_id uuid)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  o        public.orders%rowtype;

  v_next   integer;

  v_prefix text;

begin

  perform public._require_admin();

  select * into o from public.orders where id = p_order_id for update;

  if not found then

    raise exception 'Order not found.';

  end if;

  if o.status = 'cancelled' then

    raise exception 'A cancelled order cannot be invoiced.';

  end if;


 

  if o.invoice_no is null then

    insert into public.settings as s (key, value)

    values ('invoice_counter', to_jsonb(1))

    on conflict (key) do update

      set value = to_jsonb(coalesce((s.value #>> '{}')::integer, 0) + 1)

    returning (s.value #>> '{}')::integer into v_next;


 

    select nullif(btrim(st.value #>> '{}'), '') into v_prefix

      from public.settings st where st.key = 'invoice_prefix';

    v_prefix := coalesce(v_prefix, 'SF-');


 

    update public.orders

       set invoice_no = v_prefix || repeat('0', greatest(0, 5 - char_length(v_next::text))) || v_next::text,

           invoice_issued_at = now(),

           updated_at = now()

     where id = p_order_id;

  end if;


 

  if o.status in ('submitted', 'confirmed') then

    perform public.admin_set_order_status(p_order_id, 'invoiced');

  end if;


 

  return public._order_json(p_order_id, true);

end $$;


 

-- Permanently removes an order (its items go with it).  p_ref must match the order, as a safety check.

-- If the order is holding stock, the stock goes back on the shelf first.

create or replace function public.admin_delete_order(p_order_id uuid, p_ref text)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  o          public.orders%rowtype;

  v_items    integer;

  v_restored boolean := false;

begin

  perform public._require_admin();

  select * into o from public.orders where id = p_order_id for update;

  if not found then

    raise exception 'Order not found.';

  end if;

  if upper(btrim(coalesce(p_ref, ''))) <> o.ref then

    raise exception 'The order reference did not match. Nothing was deleted.';

  end if;


 

  select coalesce(sum(qty), 0) into v_items from public.order_items where order_id = o.id;

  if o.stock_deducted then

    perform public._restore_stock(o.id);

    v_restored := true;

  end if;


 

  insert into public.order_deletions (ref, invoice_no, status, total, items_count, deleted_by)

  values (o.ref, o.invoice_no, o.status, o.total, v_items, auth.uid());


 

  delete from public.orders where id = o.id;      -- order_items are removed with it


 

  return jsonb_build_object('ref', o.ref, 'invoice_no', o.invoice_no, 'stock_restored', v_restored);

end $$;


 

create or replace function public.admin_get_settings()

returns jsonb

language plpgsql security definer set search_path = public

as $$

begin

  perform public._require_admin();

  return coalesce((select jsonb_object_agg(s.key, s.value) from public.settings s), '{}'::jsonb);

end $$;


 

create or replace function public.admin_save_settings(p jsonb)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  k text;

begin

  perform public._require_admin();

  if p is null or jsonb_typeof(p) <> 'object' then

    raise exception 'Invalid settings.';

  end if;


 

  foreach k in array array['business_name','abn','business_phone','business_email',

                           'business_address','bank_details','invoice_footer','invoice_prefix']

  loop

    if p ? k then

      if jsonb_typeof(p -> k) <> 'string' or char_length(p ->> k) > 1000 then

        raise exception 'Invalid value for %.', k;

      end if;

      if k = 'invoice_prefix' and (p ->> k) !~ '^[A-Za-z0-9_-]{0,10}$' then

        raise exception 'Invoice prefix can only use letters, numbers, - and _ (10 characters max).';

      end if;

      insert into public.settings (key, value) values (k, p -> k)

      on conflict (key) do update set value = excluded.value;

    end if;

  end loop;


 

  if p ? 'gst_registered' then

    if jsonb_typeof(p -> 'gst_registered') <> 'boolean' then

      raise exception 'Invalid value for gst_registered.';

    end if;

    insert into public.settings (key, value) values ('gst_registered', p -> 'gst_registered')

    on conflict (key) do update set value = excluded.value;

  end if;


 

  if p ? 'stock_mode' then

    if jsonb_typeof(p -> 'stock_mode') <> 'string'

       or (p ->> 'stock_mode') not in ('on_submit', 'on_confirm') then

      raise exception 'Invalid stock mode.';

    end if;

    insert into public.settings (key, value) values ('stock_mode', p -> 'stock_mode')

    on conflict (key) do update set value = excluded.value;

  end if;


 

  return public.admin_get_settings();

end $$;


 

create or replace function public.admin_get_catalog()

returns jsonb

language plpgsql security definer set search_path = public

as $$

begin

  perform public._require_admin();

  return public._catalog_json(true);

end $$;


 

-- Create or update ONE product together with all its sizes.

-- p: {id?, name, category, note, image, sort_order, active,

--     variants:[{id?, weight, price, stock (blank = made to order), active}]}

-- Sizes that are left out of the list are removed.

create or replace function public.admin_save_product(p jsonb)

returns jsonb

language plpgsql security definer set search_path = public

as $$

declare

  v_id      uuid;

  v_name    text := btrim(coalesce(p ->> 'name', ''));

  v_cat     text := coalesce(p ->> 'category', '');

  v_note    text := nullif(btrim(coalesce(p ->> 'note', '')), '');

  v_image   text := nullif(btrim(coalesce(p ->> 'image', '')), '');

  v_sort    integer;

  v_active  boolean := coalesce((p ->> 'active')::boolean, true);

  v_keep    uuid[] := '{}';

  vr        jsonb;

  v_vid     uuid;

  v_weight  text;

  v_price   numeric;

  v_stock   integer;

  v_vactive boolean;

  v_pos     integer := 0;

begin

  perform public._require_admin();


 

  if char_length(v_name) < 1 or char_length(v_name) > 120 then

    raise exception 'Please enter a product name.';

  end if;

  if v_cat not in ('spices', 'appalam') then

    raise exception 'Please choose a category.';

  end if;

  if v_note is not null and char_length(v_note) > 200 then

    raise exception 'The note is too long (200 characters maximum).';

  end if;

  if v_image is not null and v_image !~ '^[A-Za-z0-9._-]+\.png$' then

    raise exception 'The photo file name must look like sambar-powder.png';

  end if;

  if coalesce(p ->> 'sort_order', '') !~ '^-?[0-9]{1,6}$' then

    v_sort := 0;

  else

    v_sort := (p ->> 'sort_order')::integer;

  end if;

  if jsonb_typeof(p -> 'variants') is distinct from 'array' or jsonb_array_length(p -> 'variants') = 0 then

    raise exception 'Add at least one size and price.';

  end if;


 

  if coalesce(p ->> 'id', '') = '' then

    insert into public.products (name, category, note, image, sort_order, active)

    values (v_name, v_cat, v_note, v_image, v_sort, v_active)

    returning id into v_id;

  else

    v_id := (p ->> 'id')::uuid;

    update public.products

       set name = v_name, category = v_cat, note = v_note, image = v_image,

           sort_order = v_sort, active = v_active

     where id = v_id;

    if not found then

      raise exception 'Product not found.';

    end if;

  end if;


 

  for vr in select e.value from jsonb_array_elements(p -> 'variants') as e(value)

  loop

    v_pos := v_pos + 1;

    v_weight := btrim(coalesce(vr ->> 'weight', ''));

    if char_length(v_weight) < 1 or char_length(v_weight) > 40 then

      raise exception 'Each size needs a weight, for example 200 gm.';

    end if;

    if coalesce(vr ->> 'price', '') !~ '^[0-9]{1,6}(\.[0-9]{1,2})?$' then

      raise exception 'Enter a valid price for % (use numbers only, e.g. 7.50).', v_weight;

    end if;

    v_price := (vr ->> 'price')::numeric;


 

    if coalesce(vr ->> 'stock', '') = '' then

      v_stock := null;                                   -- made to order

    elsif (vr ->> 'stock') ~ '^[0-9]{1,6}$' then

      v_stock := (vr ->> 'stock')::integer;

    else

      raise exception 'Stock for % must be a whole number, or blank for made to order.', v_weight;

    end if;

    v_vactive := coalesce((vr ->> 'active')::boolean, true);


 

    if coalesce(vr ->> 'id', '') = '' then

      insert into public.product_variants (product_id, weight, price, stock_qty, active, sort_order)

      values (v_id, v_weight, v_price, v_stock, v_vactive, v_pos)

      returning id into v_vid;

    else

      v_vid := (vr ->> 'id')::uuid;

      update public.product_variants

         set weight = v_weight, price = v_price, stock_qty = v_stock,

             active = v_vactive, sort_order = v_pos

       where id = v_vid and product_id = v_id;

      if not found then

        raise exception 'Size not found.';

      end if;

    end if;

    v_keep := v_keep || v_vid;

  end loop;


 

  delete from public.product_variants

   where product_id = v_id and not (id = any (v_keep));


 

  return jsonb_build_object('id', v_id);

exception

  when unique_violation then

    raise exception 'Two sizes of this product have the same weight.';

end $$;


 

create or replace function public.admin_delete_product(p_id uuid)

returns void

language plpgsql security definer set search_path = public

as $$

begin

  perform public._require_admin();

  delete from public.products where id = p_id;

  if not found then

    raise exception 'Product not found.';

  end if;

end $$;



 

-- ---------------------------------------------------------------------

-- 8. WHO CAN CALL WHAT

-- ---------------------------------------------------------------------


 

revoke execute on all functions in schema public from public, anon, authenticated;


 

-- customers and guests

grant execute on function public.get_catalog()                 to anon, authenticated;

grant execute on function public.place_order(jsonb, jsonb)     to anon, authenticated;

grant execute on function public.track_order(text, text)       to anon, authenticated;

grant execute on function public.is_admin()                    to anon, authenticated;


 

-- logged-in customers

grant execute on function public.get_my_profile()              to authenticated;

grant execute on function public.save_my_profile(jsonb)        to authenticated;

grant execute on function public.my_orders()                   to authenticated;


 

-- admins (each function re-checks the admins table)

grant execute on function public.admin_list_orders()           to authenticated;

grant execute on function public.admin_get_order(uuid)         to authenticated;

grant execute on function public.admin_set_order_status(uuid, text) to authenticated;

grant execute on function public.admin_update_order(uuid, jsonb, numeric, numeric, text) to authenticated;

grant execute on function public.admin_issue_invoice(uuid)     to authenticated;

grant execute on function public.admin_delete_order(uuid, text) to authenticated;

grant execute on function public.admin_get_settings()          to authenticated;

grant execute on function public.admin_save_settings(jsonb)    to authenticated;

grant execute on function public.admin_get_catalog()           to authenticated;

grant execute on function public.admin_save_product(jsonb)     to authenticated;

grant execute on function public.admin_delete_product(uuid)    to authenticated;



 

-- ---------------------------------------------------------------------

-- 9. STARTING DATA

-- ---------------------------------------------------------------------


 

insert into public.settings (key, value) values

  ('stock_mode',       '"on_submit"'),

  ('business_name',    '"Swamy Foods"'),

  ('abn',              '""'),

  ('business_phone',   '"0493 129 799"'),

  ('business_email',   '"enquiry@swamyfoods.com.au"'),

  ('business_address', '"Cranbourne North, VIC 3977"'),

  ('gst_registered',   'false'),

  ('bank_details',     '""'),

  ('invoice_footer',   '"Thank you for your order."'),

  ('invoice_prefix',   '"SF-"'),

  ('invoice_counter',  '0')

on conflict (key) do nothing;


 

-- Your current price list (from index.html).  Stock is blank = made to order /

-- always available.  Enter real stock numbers in the admin page.

do $$

begin

  if not exists (select 1 from public.products) then

    with seed (name, category, weight, price, sort_order) as (

      values

        ('Nalla Karam Powder',          'spices',  '200 gm',  8.00,  1),

        ('Paruppu [Kandi] Powder',      'spices',  '200 gm',  7.50,  2),

        ('Idly / Dosa Chilli Powder',   'spices',  '200 gm',  7.00,  3),

        ('Peanut Chutney Powder',       'spices',  '200 gm',  8.00,  4),

        ('Ellu Podi / Nuvvula Kaaram',  'spices',  '200 gm',  7.50,  5),

        ('Sambar Powder',               'spices',  '500 gm', 15.00,  6),

        ('Curry Leaves Powder',         'spices',  '200 gm',  9.00,  7),

        ('Instant Adai [Dal Dosa] Mix', 'spices',  '500 gm',  7.00,  8),

        ('Mor Kozhambu Mix',            'spices',  '300 gm',  8.50,  9),

        ('Rasam Powder',                'spices',  '200 gm',  7.50, 10),

        ('Curry Powder',                'spices',  '200 gm',  7.50, 11),

        ('Energy & Protein Health Mix', 'spices',  '225 gm',  8.00, 12),

        ('Rice Appalam',                'appalam', '200 gm',  5.00, 13),

        ('Tomato Appalam',              'appalam', '200 gm',  5.00, 14),

        ('Ragi Appalam',                'appalam', '200 gm',  5.00, 15),

        ('Tapioca [Marchini] Appalam',  'appalam', '200 gm',  5.00, 16),

        ('Ilavadagam',                  'appalam', '200 gm',  5.00, 17),

        ('Sago [Javvarisi] Vadam',      'appalam', '250 gm',  6.00, 18),

        ('Omapodi Vadam',               'appalam', '250 gm',  6.00, 19),

        ('Ribbon Vadam',                'appalam', '250 gm',  6.00, 20),

        ('Neetu [Rice] Vadam',          'appalam', '250 gm',  6.00, 21)

    ),

    ins as (

      insert into public.products (name, category, sort_order)

      select name, category, sort_order from seed

      returning id, name

    )

    insert into public.product_variants (product_id, weight, price, sort_order)

    select ins.id, seed.weight, seed.price, 1

      from seed join ins on ins.name = seed.name;

  end if;

end $$;


 

-- make the new functions visible to the website straight away

notify pgrst, 'reload schema';


 
