// Urban Flame - shared front-end behaviour (no backend, client-side only)
document.addEventListener('DOMContentLoaded', () => {

    const searchInput = document.querySelector('.srch');
    const searchBtn = document.getElementById('search-btn');
    const menuContainer = document.querySelector('.menu-container');

    function filterMenu(term) {
        const lower = term.trim().toLowerCase();
        document.querySelectorAll('.menu-category').forEach(category => {
            let anyVisible = false;
            category.querySelectorAll('.menu-item').forEach(item => {
                const name = item.querySelector('.item-name')?.textContent.toLowerCase() || '';
                const desc = item.querySelector('.item-description')?.textContent.toLowerCase() || '';
                const match = !lower || name.includes(lower) || desc.includes(lower);
                item.style.display = match ? '' : 'none';
                if (match) anyVisible = true;
            });
            category.style.display = anyVisible ? '' : 'none';
        });
    }

    function runSearch() {
        const term = searchInput ? searchInput.value : '';
        if (menuContainer) {
            filterMenu(term);
        } else if (term.trim()) {
            window.location.href = 'menu.html?q=' + encodeURIComponent(term.trim());
        }
    }

    if (searchInput) {
        if (searchBtn) searchBtn.addEventListener('click', e => { e.preventDefault(); runSearch(); });
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
        });
        if (menuContainer) searchInput.addEventListener('input', () => filterMenu(searchInput.value));
    }

    // Menu page: honour ?q= search term coming from another page
    if (menuContainer) {
        const q = new URLSearchParams(window.location.search).get('q');
        if (q) {
            if (searchInput) searchInput.value = q;
            filterMenu(q);
        }
    }

    // Login form (Restaurant.html)
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', e => {
            e.preventDefault();
            const email = document.getElementById('login-email').value.trim();
            const password = document.getElementById('login-password').value;
            if (!email || !password) {
                alert('Please enter both email and password.');
                return;
            }
            const users = JSON.parse(localStorage.getItem('uf_users') || '{}');
            const account = users[email];
            if (account && account.password === password) {
                alert('Welcome back, ' + account.name + '!');
                loginForm.reset();
            } else {
                alert("We couldn't find that account. Please sign up first.");
            }
        });
    }

    // Sign up form
    const signUpForm = document.getElementById('contact-form');
    if (signUpForm) {
        signUpForm.addEventListener('submit', e => {
            e.preventDefault();
            const name = document.getElementById('name').value.trim();
            const email = document.getElementById('email').value.trim();
            const phone = document.getElementById('phone').value.trim();
            const message = document.getElementById('message').value.trim();
            if (!name || !email || !message) {
                alert('Please fill in your name, email, and message.');
                return;
            }
            const users = JSON.parse(localStorage.getItem('uf_users') || '{}');
            users[email] = { name, phone, message, password: 'welcome123' };
            localStorage.setItem('uf_users', JSON.stringify(users));
            alert('Thanks for signing up, ' + name + '! Your demo password is "welcome123" - use it to log in on the home page.');
            window.location.href = 'Restaurant.html';
        });
    }
});
