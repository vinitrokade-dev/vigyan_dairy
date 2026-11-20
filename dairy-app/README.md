# Vigyan Dairy Products

Vigyan Dairy Products is a dairy ordering app built with HTML, CSS, JavaScript, Node.js, Express and SQLite.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000

## Owner login

- Username: `admin`
- Password: `admin123`

Change these before first use by setting `ADMIN_USER` and `ADMIN_PASS` environment variables. The owner account is created only once, on first run.

## Customer features

- Customer registration and login
- Dairy product selection and quantity controls
- Optional note with each order
- Order history and status updates
- Customer profile details
- Responsive white-and-green customer page
- Product photography and general nutrition notes

## Owner features

- View incoming orders and live notifications
- Accept, deliver or cancel orders
- Add, hide or delete products

## Notes

Product photos are loaded from Unsplash image URLs, so the customer page needs an internet connection to display them. Check the relevant image licensing/usage terms before commercial deployment. Nutrition notes are general information only; product labels should be used for exact nutrition values.
