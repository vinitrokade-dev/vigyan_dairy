# Vigyan Dairy Products

A dairy ordering application built with HTML, CSS, JavaScript, Node.js, Express and SQLite.

## Run locally

npm install
npm start

Open http://localhost:3000.

The local SQLite database is dairy.db in this project folder unless DATA_DIR is set.

## Render deployment

1. Keep the Render service connected to the correct GitHub repository and main branch.
2. Build command: npm install
3. Start command: npm start
4. Add a Render persistent disk mounted at /var/data.
5. Add environment variable DATA_DIR=/var/data.
6. Before switching an existing live service to a new disk, back up the current dairy.db and copy it to /var/data/dairy.db. Do not start with an empty persistent database if you need to keep existing users, products and orders.
7. Redeploy and check /api/health. This version returns build hard-delete-v2-2026-11-21.

The application logs the database file path at startup. Check Render logs to confirm it points inside /var/data.

## Owner login

The default first-run owner credentials are username admin and password admin123.

Set ADMIN_USER and ADMIN_PASS in the environment before the first run.

The app does not print the password in logs. If an owner account already exists, changing these environment variables does not automatically change that existing account's password.

## Product deletion and order history

The owner Delete action permanently removes the product from the products table.

Before deletion, the server ensures historical order items have saved product name, unit and emoji snapshots. Orders remain in the database and continue to display those saved details.

Hiding a product remains a separate action.

## Customer features

- Customer registration and login
- Dairy product selection and quantity controls
- Optional note with each order
- Order history and status updates
- Customer profile details
- Responsive customer page

## Owner features

- View incoming orders and live notifications
- Accept, deliver or cancel orders
- Add, hide, show or permanently delete products