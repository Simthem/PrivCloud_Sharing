UPDATE "Config"
SET "value" = replace("value", 'released under the BSD 2-Clause license', 'distributed under AGPL-3.0-only for the combined application, with retained BSD and other third-party license notices')
WHERE "category" = 'legal'
  AND "name" IN ('imprintText', 'imprintTextFr', 'imprintTextEn')
  AND "value" LIKE '%released under the BSD 2-Clause license%';
