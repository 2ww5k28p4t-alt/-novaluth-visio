# Visio appointment data review

**Reviewed:** 2026-09-02  
**Environment:** Development PostgreSQL database  
**Table:** `public.novaluth_visio_appointments`

## Review result

The table contained three rows. All three were created on 2026-09-02 and
cancelled during the same development test run:

| Row | Reference | Atelier | Purpose | Other links |
| ---: | --- | --- | --- | --- |
| 1 | `VIS-544534BC21F1F2` | `atelier-brumaire` | `projet` | No scheduled appointment; no order or project |
| 2 | `VIS-7E63C087748D9A` | `atelier-brumaire` | `final` | No scheduled appointment; no order or project |
| 3 | `VIS-F4552465DC7756` | `atelier-vervain` | `assemblage` | No scheduled appointment; no order or project |

Both referenced atelier profiles are labelled as fictive examples and have
`is_demo = true`. The table has no dependent database objects beyond its
own constraints, and its nullable order/project references are empty for all
three rows.

## Retention decision

These are disposable development fixtures from the removed Visio feature, not
real appointments or business records. They have no retention requirement.
No export or archive is needed, and the rows may be discarded together with
the obsolete table as part of the development schema cleanup.

Sensitive appointment token hashes and email addresses were intentionally not
copied into this review document.