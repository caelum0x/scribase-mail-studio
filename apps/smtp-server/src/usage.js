const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "localhost",
  port: 25,
  secure: false,
  auth: {
    user: "scribase",
    pass: "us_123",
  },
  tls: {
    rejectUnauthorized: false,
  },
});

const mailOptions = {
  to: "sender@example.com",
  from: "hello@example.com",
  subject: "Testing SMTP",
  html: "<strong>THIS IS USING SMTP,</strong><p>This is a test email from Scribase Mail.</p>",
  text: "hello,\n\nThis is a test email from Scribase Mail.",
};

transporter.sendMail(mailOptions, (error, info) => {
  if (error) {
    console.error("Error sending email:", error);
  } else {
    console.log("Email sent successfully:", info.response);
  }
});
