const { Router } = require('express');
const { createTransaction } = require('../controllers/transactionController');

const router = Router();

router.post('/transactions', createTransaction);

module.exports = router;
