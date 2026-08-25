const { Router } = require('express');
const { createTransaction, getTransaction } = require('../controllers/transactionController');

const router = Router();

router.post('/transactions', createTransaction);
router.get('/transactions/:externalId', getTransaction);

module.exports = router;
