import { kv } from '../lib/kv.js';
import * as productsSql from '../lib/products.js';

export default async function handler(req, res) {
  const { action } = req.query;

  if (!action) {
    return res.status(400).json({ error: 'Action parameter required' });
  }

  // Handle GET request (for 'data' action)
  if (req.method === 'GET' && action === 'data') {
    return handleGetData(req, res);
  }

  // Handle POST requests
  if (req.method === 'POST') {
    if (action === 'migrate') {
      return handleMigrate(req, res);
    } else if (action === 'backfill') {
      return handleBackfill(req, res);
    }
  }

  // Handle OPTIONS for CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
    return res.status(200).end();
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// DATA: Get cached sales data from KV
async function handleGetData(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  try {
    const { type, startDate, endDate } = req.query;

    if (!type) {
      return res.status(400).json({ error: 'Type parameter required' });
    }

    // Get data from KV based on type
    let data;
    
    if (type === 'transactions') {
      // Fetch transaction data for date range
      const allTransactions = await kv.get('transactions') || [];
      
      if (startDate && endDate) {
        data = allTransactions.filter(t => {
          const txDate = t.date || t['posted-date'];
          return txDate >= startDate && txDate <= endDate;
        });
      } else {
        data = allTransactions;
      }
    } else if (type === 'summary') {
      // Fetch summary/aggregated data
      data = await kv.get('summary');
    } else if (type === 'products') {
      // Fetch product data
      data = productsSql.productsInSql() ? await productsSql.getProducts() : await kv.get('products');
    } else {
      return res.status(400).json({ error: 'Invalid type parameter' });
    }

    return res.status(200).json({
      success: true,
      data: data || []
    });

  } catch (error) {
    console.error('Error fetching data:', error);
    return res.status(500).json({ error: 'Failed to fetch data: ' + error.message });
  }
}

// MIGRATE: One-time migration from Google Sheets to KV
async function handleMigrate(req, res) {
  const adminToken = req.headers['x-admin-token'];
  
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - Invalid admin token' });
  }

  try {
    console.log('🚀 Starting migration...');

    const { spreadsheetId, accessToken } = req.body;

    if (!spreadsheetId || !accessToken) {
      return res.status(400).json({ error: 'Missing spreadsheetId or accessToken' });
    }

    // Fetch all sheets data
    const sheets = ['Transactions', 'Products', 'ShippingCosts', 'ProductAdSpend', 'BrandAdSpend'];
    const allData = {};

    for (const sheet of sheets) {
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheet}`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );

      if (response.ok) {
        const data = await response.json();
        allData[sheet.toLowerCase()] = data.values || [];
      }
    }

    // Store in KV
    for (const [key, value] of Object.entries(allData)) {
      await kv.set(key, value);
    }

    return res.status(200).json({
      success: true,
      message: 'Migration complete',
      recordCounts: Object.fromEntries(
        Object.entries(allData).map(([k, v]) => [k, v.length])
      )
    });

  } catch (error) {
    console.error('Migration error:', error);
    return res.status(500).json({ error: 'Migration failed: ' + error.message });
  }
}

// BACKFILL: Fetch historical transaction data and store in KV
async function handleBackfill(req, res) {
  const adminToken = req.headers['x-admin-token'];
  
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - Invalid admin token' });
  }

  try {
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start and end dates required' });
    }

    // Note: Actual SP-API backfill logic would go here
    // For now, this is a placeholder that returns success
    
    return res.status(200).json({
      success: true,
      message: `Backfill queued for ${startDate} to ${endDate}`,
      note: 'Implementation pending - Amazon SP-API integration required'
    });

  } catch (error) {
    console.error('Backfill error:', error);
    return res.status(500).json({ error: 'Backfill failed: ' + error.message });
  }
}
