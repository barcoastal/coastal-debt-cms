-- Tenant-scoped, read-only projection for Coastal's A/B dashboard.
-- No raw contact details, payouts, other accounts, or configuration secrets.
CREATE SCHEMA IF NOT EXISTS coastal_ab;
CREATE OR REPLACE VIEW coastal_ab.crm_leads WITH (security_barrier=true) AS
SELECT l."sourceId" AS id,
  left(l.payload->>'CreatedDate',10) AS created_day,
  l.payload->>'CreatedDate' AS created_at,
  encode(sha256(convert_to(lower(trim(l.payload->>'Email')),'UTF8')),'hex') AS email_hash,
  encode(sha256(convert_to(lower(regexp_replace(trim(l.payload->>'Name'),'\s+',' ','g')) || '|' ||
    lower(regexp_replace(trim(l.payload->>'Company'),'\s+',' ','g')),'UTF8')),'hex') AS name_hash,
  l.payload->>'ConvertedOpportunityId' AS converted_opportunity_id,
  COALESCE(active."sourceId",o."sourceId") AS opportunity_id,
  COALESCE(active.payload->>'StageName',o.payload->>'StageName') AS stage
FROM "SfReportingRecord" l
LEFT JOIN "SfReportingRecord" o ON o."accountId"=l."accountId" AND o."orgId"=l."orgId"
  AND o."objectType"='Opportunity' AND o."sourceId"=l.payload->>'ConvertedOpportunityId' AND NOT o."isDeleted"
LEFT JOIN "SfReportingRecord" active ON active."accountId"=o."accountId" AND active."orgId"=o."orgId"
  AND active."objectType"='Opportunity' AND active."sourceId"=o.payload->>'Active_Opportunity__c' AND NOT active."isDeleted"
WHERE l."accountId"='demo-account' AND l."orgId"='00D8Y000001ZRTZUA4'
  AND l."objectType"='Lead' AND l.brand='coastal' AND NOT l."isDeleted";

CREATE OR REPLACE VIEW coastal_ab.clicks WITH (security_barrier=true) AS
SELECT id FROM "Click" WHERE "accountId"='demo-account';
CREATE OR REPLACE VIEW coastal_ab.events WITH (security_barrier=true) AS
SELECT "clickId" AS click_id, "typeKey" AS type, status, txid, ts AS occurred_at
FROM "Conversion" WHERE "accountId"='demo-account' AND "typeKey" IN ('opportunity','closed_won');
CREATE OR REPLACE VIEW coastal_ab.sync WITH (security_barrier=true) AS
SELECT "objectType" AS object_type,status,"updatedAt" AS updated_at
FROM "SfReportingSync" WHERE "accountId"='demo-account' AND "orgId"='00D8Y000001ZRTZUA4'
  AND "objectType" IN ('Lead','Opportunity');
