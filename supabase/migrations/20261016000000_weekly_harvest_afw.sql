-- Plants: AFW is per harvest week — rename cohort_afw to weekly_harvest_afw
--
-- Approved 2026-10-05: the AFW entered for week W is the average fruit weight
-- of the peppers HARVESTED in week W (whichever week they set), used for that
-- week's Picked kg:
--
--   picked kg (week W) = Harvested/m² (W) × crop area m² × AFW g (W) ÷ 1000
--
-- The table was created as cohort_afw with set_year/set_week. This renames it
-- and its columns, constraints, trigger and trigger function to say what the
-- values mean. Renames only: every row (values, authors, timestamps) stays as
-- it is, attached to the same week. Row level security, policies and grants
-- follow the table. The CHECK constraints and primary key follow the column
-- renames. Nothing else reads this table.

alter table public.cohort_afw rename to weekly_harvest_afw;
alter table public.weekly_harvest_afw rename column set_year to year;
alter table public.weekly_harvest_afw rename column set_week to week;

alter table public.weekly_harvest_afw rename constraint cohort_afw_pkey to weekly_harvest_afw_pkey;
alter table public.weekly_harvest_afw rename constraint cohort_afw_crop_fkey to weekly_harvest_afw_crop_fkey;
alter table public.weekly_harvest_afw rename constraint cohort_afw_updated_by_fkey to weekly_harvest_afw_updated_by_fkey;
alter table public.weekly_harvest_afw rename constraint cohort_afw_afw_g_check to weekly_harvest_afw_afw_g_check;
alter table public.weekly_harvest_afw rename constraint cohort_afw_set_year_check to weekly_harvest_afw_year_check;
alter table public.weekly_harvest_afw rename constraint cohort_afw_iso_week_check to weekly_harvest_afw_iso_week_check;

alter function public.cohort_afw_stamp() rename to weekly_harvest_afw_stamp;
alter trigger cohort_afw_stamp on public.weekly_harvest_afw rename to weekly_harvest_afw_stamp;

comment on table public.weekly_harvest_afw is
  'Manual average fruit weight (grams) of the peppers harvested in each ISO week (year, week) of a crop. Used for that week''s Picked kg.';
comment on column public.weekly_harvest_afw.year is 'ISO year of the harvest week.';
comment on column public.weekly_harvest_afw.week is 'ISO week of the harvest week.';
comment on column public.weekly_harvest_afw.afw_g is 'Average grams per pepper harvested that week.';
