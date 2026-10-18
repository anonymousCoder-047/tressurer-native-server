const jwt = require('jsonwebtoken');

const secret = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set');
  }
  return process.env.JWT_SECRET;
};

// Token consumed by the mobile app via the Authorization: Bearer header.
const signToken = (user) =>
  jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    secret(),
    { expiresIn: '7d' }
  );

const verifyToken = (token) => jwt.verify(token, secret());

module.exports = { signToken, verifyToken };
