const authForm = document.getElementById('authForm');
const formMessage = document.getElementById('formMessage');

function validatePasswordMatch() {
  const password = authForm.elements.password;
  const confirmation = authForm.elements.confirmPassword;

  if (!confirmation) return;

  confirmation.setCustomValidity(
    confirmation.value && confirmation.value !== password.value
      ? 'Mật khẩu nhập lại chưa khớp.'
      : ''
  );
}

authForm.querySelectorAll('[data-toggle-password]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    const showPassword = input.type === 'password';

    input.type = showPassword ? 'text' : 'password';
    button.textContent = showPassword ? 'Ẩn' : 'Hiện';
    button.setAttribute('aria-label', `${showPassword ? 'Ẩn' : 'Hiện'} mật khẩu`);
  });
});

if (authForm.dataset.authMode === 'register') {
  authForm.elements.password.addEventListener('input', validatePasswordMatch);
  authForm.elements.confirmPassword.addEventListener('input', validatePasswordMatch);
}

authForm.addEventListener('input', () => {
  formMessage.textContent = '';
  formMessage.classList.remove('error');
});

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  validatePasswordMatch();

  if (!authForm.reportValidity()) return;

  formMessage.textContent = authForm.dataset.authMode === 'register'
    ? 'Biểu mẫu hợp lệ. Cần kết nối backend để tạo tài khoản.'
    : 'Biểu mẫu hợp lệ. Cần kết nối backend để xác thực tài khoản.';
});
