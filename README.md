# Urban Flame

A multi-page restaurant website built with HTML, CSS, and Vanilla JavaScript. No frameworks or backend.

## Objective

Urban Flame was created as my first web development project to practice HTML, CSS, and JavaScript by building a responsive multi-page restaurant website with client-side functionality.

## Features

- Menu page with search — filters dishes by name/description as you type
- Search from any other page redirects to the menu with that term applied
- Sign up form, saves details in the browser (`localStorage`)
- Login form, checks credentials against an account created via sign up
- Layout adapts for smaller screens (navbar, gallery, menu list, and login form re-stack below 900px)

## Screenshots

### Home
![Home](screenshots/home.jpg)

### Menu
![Menu](screenshots/menu.jpg)

### About
![About](screenshots/about.jpg)

### Contact
![Contact](screenshots/contact.jpg)

### Sign Up
![Sign Up](screenshots/signup.jpg)

## Technologies Used

- HTML
- CSS
- JavaScript
- Browser `localStorage`

## Structure

```
Urban-Flame/
├── index.html      Home page (login form)
├── menu.html        Menu, with search
├── aboutus.html      About page
├── contact.html     Contact details
├── signup.html      Sign up form
├── css/              One stylesheet per page
├── js/main.js         Search, login, and signup logic
├── images/           Site images
├── screenshots/      Preview images used in this readme
└── README.md
```

## How to Run

Open `index.html` in a browser, or serve the folder locally:

```
cd Urban-Flame
python -m http.server 8000
```

Then go to `http://localhost:8000`.

## Limitations

- No backend or database
- Login and sign up only work within the same browser (`localStorage`), not across devices
- Not real authentication — passwords aren't hashed or verified against a server
