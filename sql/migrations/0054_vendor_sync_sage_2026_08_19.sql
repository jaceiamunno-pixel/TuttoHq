-- 0054_vendor_sync_sage_2026_08_19.sql
-- Reconciles public.vendors (THP) against the Sage vendor report
-- Vendor_List_Aug_19_2026, treating that report as authoritative for
-- WHICH vendor numbers exist. No deletes. No overwrite of existing
-- phone / email / contact_name — the report carries none of those.
--
--   Part A  70 inserts  — vendor_nos in the report with no prod row at all
--   Part B   3 updates  — firms that already exist in prod as UNNUMBERED rows
--                         carrying live submittal FKs. These get the vendor_no
--                         backfilled onto the existing row; inserting instead
--                         would orphan 8 submittals across two duplicate rows.
--
-- Idempotent. Part A is guarded on (company_id, vendor_no); Part B is guarded
-- on the row still being unnumbered.
-- Zip codes repadded where the Sage report stripped the leading zero.
-- Flags default to is_supplier — retag subs in the Vendors settings UI.

begin;

-- ── Part A: 70 new vendors ────────────────────────────────────────────────
with incoming(vendor_no, company_name, street_address, city, state, zip_code) as (
  values
  ('150', 'Accurate Door and WIndow', '394 North Main St', 'Norwich', 'CT', '06360'),
  ('199', 'Aladdin Temp-Rite', '250 E Main St', 'Hendersonville', 'TN', '37075'),
  ('202', 'Advance Stl Rinfrcng Co.', '107 Thompson St.', 'Bridgeport', 'CT', '06604'),
  ('254', 'American Spray Fm Insltn', '3 Apple Hill Rd', 'Wolcott', 'CT', '06716'),
  ('256', 'Americana Outdoors', 'PO Box 1290', 'Salem', 'IL', '62881'),
  ('442', 'Bay State Buildng Spclts', '144 Lundquist Dr', 'Braintree', 'MA', '02184'),
  ('771', 'Blue Power Wash', '45 Mayfair Pl', 'Stratford', 'CT', '06615'),
  ('854', 'Brasco International', '32400 Industrial Dr', 'Madison Heights', 'MI', '48071'),
  ('1105', 'Kishaon Diaz', '442 Summitt St', 'Bridgeport', 'CT', '06606'),
  ('1106', 'William Duran', '168 Mulloy Rd', 'Waterbury', 'CT', '06701'),
  ('1121', 'Carlos Flores', '12 BLue Cliff Terrace', 'New Haven', 'CT', '06513'),
  ('1153', 'Christopher Hughes', '11 Crestwood Rd', 'Ansonia', 'CT', '06401'),
  ('1216', 'Big Bills Plmbng and Htn', '15 Biltmore Rd', 'Shelton', 'CT', '06484'),
  ('1301', 'Cmars Engineering', '58 Orchard Hill Rd', 'Branford', 'CT', '06405-4217'),
  ('1378', 'Carrier Enterpris NE LLC', 'PO Box 33133', 'Newark', 'NJ', '07188-0133'),
  ('1533', 'Charles Mapes', '276 Parker Farms Rd', 'Wallingford', 'CT', '06412'),
  ('1536', 'Akeem Morris', '73 Broad St', 'New Britain', 'CT', '06053'),
  ('1736', 'Coastline Insulation', '130 Old Gate Ln', 'Milford', 'CT', '06460'),
  ('1841', 'Comcast Business', 'PO BOX 70219', 'Philadelphia', 'PA', '19176-0219'),
  ('2081', 'Bomanite Systems NE LLC', '7 Trowbridge Dr # A', 'Bethel', 'CT', '06801'),
  ('2248', 'Convergint', '4 Research Dr', 'Bethel', 'CT', '06801'),
  ('2256', 'Copeland Furniture', '156 Industrial Dr', 'Bradford', 'VT', '06033'),
  ('2346', 'Cover-All Drywall, LLC', '127 Washington St', 'Milford', 'CT', '06460'),
  ('2871', 'DeMartino Fixture Co Inc', '920 S Colony Rd', 'Wallingford', 'CT', '06492'),
  ('2981', 'Desco Wood', '290 Somers Rd', 'Ellington', 'CT', '06029'),
  ('3100', 'Downeast Structrl Prtnrs', '12 Colby Rd', 'Litchfield', 'NH', '03052'),
  ('3263', 'East Coast Sht Metal LLC', '141 Woodruff St', 'Litchfield', 'CT', '06759'),
  ('3419', 'Eden Farms', '947 Stillwater Rd', 'Stamford', 'CT', '06902'),
  ('3463', 'Emerson Swan', '300 Pond St', 'Randolph', 'MA', '02368'),
  ('3464', 'Envirnmntl Tstng & Balnc', '154 State St Suite 204', 'North Haven', 'CT', '06473'),
  ('3523', 'Caratozzol Stn Desgn LLC', '51 Mollbrook Dr', 'Wilton', 'CT', '06897'),
  ('3524', 'Cardinl Engnrng Assc Inc', '180 Research Pkwy', 'Meriden', 'CT', '06450'),
  ('3609', 'Roberto Vargas', '81 Myron Ave', 'Bridgeport', 'CT', '06606'),
  ('4124', 'General Awnings', '160 W Camino Real #1033', 'Boca Raton', 'FL', '33432-5940'),
  ('4129', 'General Insulation Co', '500 Bic Dr', 'Milford', 'CT', '06461'),
  ('4771', 'Haven Steel Erectors Inc', 'PO Box 6406', 'Hamden', 'CT', '06517'),
  ('4976', 'Horbal & Judson', '52 Main St', 'Seymour', 'CT', '06483'),
  ('5003', 'IFP General Cntrctng LLC', '541 Strong St', 'East Haven', 'CT', '06512'),
  ('5228', 'John Pndrgst Cnsltng LLC', '85 Preston St', 'Windsor', 'CT', '06095'),
  ('5650', 'KraneWorks, Inc Crn Srvc', '209 Hazel Plains Rd', 'Woodbury', 'CT', '06798'),
  ('5659', 'Landscape Forms', '7800 E Michigan Ave', 'Kalamazoo', 'MI', '49048-9543'),
  ('5671', 'Lawrnc Fbrc & Metl Strct', '3509 Tr Curt Indstrl BLVD', 'St Louis', 'MO', '63122'),
  ('5944', 'LOC Scientific, Inc', '1036 Parkway CT', 'Buford', 'GA', '30518'),
  ('6254', 'Mazzotta Equipment Rntls', 'PO Box 66', 'Bridgeport', 'CT', null),
  ('6603', 'Michael Litevich', '15 Richmond St', 'East Haven', 'CT', '06512-3421'),
  ('6924', 'Multiple Mntenc Srvcs LL', '137 Qunnipiac St', 'Wallingford', 'CT', '06492'),
  ('7101', 'Napolitano Distrbtng Inc', '14 Summersweet Dr', 'Middle Island', 'NY', '11953'),
  ('7462', 'Northeast Horticultural', '25 Radel St', 'Bridgeport', 'CT', '06607'),
  ('7553', 'OFS Corporation', '260 Ellington Rd', 'South WIndsor', 'CT', '06074'),
  ('7584', 'Optimum Business', 'PO Box 70340', 'Philadelphia', 'PA', '19176-0340'),
  ('8241', 'Phoenix Metal Products', '100 Bennington Ave', 'Freeport', 'NY', '11520'),
  ('8395', 'Primo Brands', 'P.O. Box 856192', 'Louisville', 'KY', '40285-6192'),
  ('8534', 'PreCon Suite', '2831 Rose Pkwy', 'Henderson', 'NV', '89052'),
  ('8581', 'Professnl Drywll Cnstrct', '189 Brookdale Dr', 'Springfield', 'MA', '01104'),
  ('8593', 'Promein Steel', '76 Depot Rd', 'Berlin', 'CT', '06037'),
  ('8731', 'Quality Woodworks', '1 Riverside Dr', 'Ansonia', 'CT', '06401-1228'),
  ('8853', 'PC Paintng and Rstrtn LL', '321 South Orchard St', 'Wallingford', 'CT', '06492'),
  ('8857', 'Recycle Away', '5 Canal St', 'Bellows Falls', 'VT', '05101'),
  ('9097', 'Roman Lndscpng & Cns LLC', '97 Patten Rd', 'North Haven', 'CT', '06473'),
  ('9233', 'Safety Storage Inc', '855 N 5th St', 'Charleston', 'IL', '61920'),
  ('9306', 'Securitas Technology Crp', '3800 Tabs Dr', 'Uniontown', 'OH', '44658'),
  ('9316', 'Seismic Cntrl Prdcts LLC', '330 Main St, STE 24', 'Manchester', 'CT', '06040'),
  ('9726', 'Strong Cohen LLC', '1146 Chapel St', 'New Haven', 'CT', '06511'),
  ('9782', 'Super Epoxy and Watrprf', '2 Cinnamon Ln', 'Portland', 'CT', '06480'),
  ('9841', '3M SIte Developmnt Pavng', '1071 Middletown Ave', 'Northford', 'CT', '06472'),
  ('9992', 'TriMark Marlinn LLC', 'PO Box 8570', 'Carol Stream', 'IL', '60197-8570'),
  ('10017', 'Tunstall Corporation', 'PO Box 434', 'Springfield', 'MA', null),
  ('10101', 'US Hazmat Rentals', '355 Industrial Park Dr', 'Boone', 'NC', '28607'),
  ('10578', 'WJ Kettleworks', '61 Sperry Ave', 'Stratford', 'CT', '06615'),
  ('10605', 'Yankee Metals', '76 Knowlton St', 'Bridgeport', 'CT', '06608')
)
insert into public.vendors
  (company_id, vendor_no, company_name, street_address, city, state, zip_code,
   is_supplier, is_subcontractor)
select 'c7c08273-8d0a-40fd-8f67-b712955eeb47'::uuid, i.vendor_no, i.company_name, i.street_address, i.city,
       i.state, nullif(i.zip_code,''), true, false
from incoming i
where not exists (
  select 1 from public.vendors v
  where v.company_id = 'c7c08273-8d0a-40fd-8f67-b712955eeb47'::uuid
    and v.vendor_no  = i.vendor_no
);

-- ── Part B: 3 merges onto existing unnumbered rows ────────────────────────

-- Lumichron: existing unnumbered row, live submittal FKs — backfill, do not insert
update public.vendors set
  vendor_no      = '6035',
  company_name   = 'Lumichron Comm Clocks',
  street_address = coalesce(nullif(street_address,''), '11460 Dorsett Rd'),
  city           = coalesce(nullif(city,''),           'Maryland Hghts'),
  state          = coalesce(nullif(state,''),          'MO'),
  zip_code       = coalesce(nullif(zip_code,''),       '63043')
where id = '4421b133-53f9-41d2-8816-58a6a3fc616a'::uuid
  and company_id = 'c7c08273-8d0a-40fd-8f67-b712955eeb47'::uuid
  and (vendor_no is null or vendor_no = '');

-- New England Interior Specialties: existing unnumbered row, live submittal FKs — backfill, do not insert
update public.vendors set
  vendor_no      = '7111',
  company_name   = 'New England Interior Specialties',
  street_address = coalesce(nullif(street_address,''), '124 Main St'),
  city           = coalesce(nullif(city,''),           'Norfolk'),
  state          = coalesce(nullif(state,''),          'MA'),
  zip_code       = coalesce(nullif(zip_code,''),       '02056')
where id = 'c588196d-beb5-41d3-8a7b-165016b64d36'::uuid
  and company_id = 'c7c08273-8d0a-40fd-8f67-b712955eeb47'::uuid
  and (vendor_no is null or vendor_no = '');

-- W.S Sign: existing unnumbered row, live submittal FKs — backfill, do not insert
update public.vendors set
  vendor_no      = '10587',
  company_name   = 'W.S. Sign Design Corp',
  street_address = coalesce(nullif(street_address,''), '884 Alden St'),
  city           = coalesce(nullif(city,''),           'Springfield'),
  state          = coalesce(nullif(state,''),          'MA'),
  zip_code       = coalesce(nullif(zip_code,''),       '01109')
where id = '98f691c0-4fda-4f06-8450-67d0b8b1f51e'::uuid
  and company_id = 'c7c08273-8d0a-40fd-8f67-b712955eeb47'::uuid
  and (vendor_no is null or vendor_no = '');

commit;

-- ── Post-apply verification (run separately, read-only) ───────────────────
-- select count(*) from public.vendors
--  where company_id = 'c7c08273-8d0a-40fd-8f67-b712955eeb47'::uuid;                       -- expect 1519
-- select count(*) from public.vendors
--  where company_id = 'c7c08273-8d0a-40fd-8f67-b712955eeb47'::uuid
--    and (vendor_no is null or vendor_no = '');            -- expect 10
-- select vendor_no, company_name from public.vendors
--  where company_id = 'c7c08273-8d0a-40fd-8f67-b712955eeb47'::uuid
--    and vendor_no in ('6035','7111','10587');             -- expect 3 rows, 1 each
