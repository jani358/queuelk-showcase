# Screenshots to capture

Drop the PNGs in this directory using exactly these filenames — the README table
already points at them, so the images appear the moment the files exist.

Run the seed first (`npm run prisma:seed` in `apps/api`). It creates **Sunrise
Dispensary** with three queues and roughly 43 tokens spread across the day with
realistic timestamps, so every screen looks like a clinic mid-morning rather than
an empty demo.

| Filename | What to capture |
|---|---|
| `01-display.png` | **The waiting-room TV** (`/d/sunrise-dispensary`) — three queues, each with its big "now serving" number. Capture at 1920×1080 and full-screen, because that is the real deployment target. Catch it on a Sinhala or Tamil label rotation rather than English. |
| `02-patient-phone.png` | **The patient's phone** (`/t/<publicId>`) at phone width — their token number, how many people are ahead, and the estimated wait. This is the screen that solves the actual problem, so it is worth getting right. |
| `03-patient-nearly.png` | The same page in its "you are two away" alert state, with the alert-me control visible. |
| `04-console.png` | **The staff console** (`/console`) on a tablet-width viewport, with the "Call next" button in the thumb zone and a queue of waiting patients beside it. |
| `05-dashboard.png` | **The owner dashboard** (`/dashboard`) — today's served count, median wait, median service time, no-show rate. |
| `06-reports.png` | The reports screen with the date range and the CSV export control. |
| `07-qr-poster.png` | **The printable QR poster** (`/dashboard/qr`) — trilingual, with the QR code and the typable fallback URL. The QR encoder is hand-rolled with no dependency, so this one is worth showing. |
| `08-take-token.png` | The public take-a-number page (`/q/sunrise-dispensary/A`) as a patient sees it after scanning. |
| `09-trilingual.png` | A single screen showing the Sinhala / Tamil / English rotation clearly — either a composite of the three states or the display mid-transition. |
| `10-swagger.png` | Swagger at `/docs` with the route list expanded. |

Capture the display and poster at full resolution; the phone and console screens
at phone/tablet widths. Crop out browser chrome and bookmarks bars.

**Before committing any screenshot:** check it contains no real patient name or
phone number, no `.env` contents, and no login credentials visible in a form.
