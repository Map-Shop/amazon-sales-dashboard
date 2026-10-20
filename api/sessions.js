import SellingPartner from 'amazon-sp-api';
import { kv } from '../lib/kv.js';

export default async function handler(req, res) {
  const { action } = req.query;

  if (!action) {
    return res.status(400).json({ error: 'Action parameter required' });
  }

  // Handle GET requests (for 'get' and 'sync' actions)
  if (req.method === 'GET') {
    if (action === 'get') {
      return handleGet(req, res);
    } else if (action === 'sync') {
      return handleSync(req, res);
    }
  }

  // All other actions are POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  switch (action) {
    case 'request':
      return handleRequest(req, res);
    case 'download':
      return handleDownload(req, res);
    case 'backfill':
      return handleBackfill(req, res);
    case 'sync':
      return handleSync(req, res);
    default:
      return res.status(400).json({ error: 'Invalid action' });
  }
}

// REQUEST: Request a new report
async function handleRequest(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    
    if (!accessToken) {
      return res.status(401).json({ error: 'No access token provided' });
    }

    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start and end dates required (YYYY-MM-DD format)' });
    }

    const sellingPartner = new SellingPartner({
      region: 'na',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET
      }
    });

    const reportResponse = await sellingPartner.callAPI({
      operation: 'createReport',
      endpoint: 'reports',
      body: {
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
        dataStartTime: `${startDate}T00:00:00Z`,
        dataEndTime: `${endDate}T23:59:59Z`,
        reportOptions: {
          asinGranularity: 'CHILD'
        }
      }
    });

    const reportId = reportResponse.reportId;

    return res.status(200).json({
      success: true,
      reportId,
      message: 'Report requested. Use report ID to check status.'
    });

  } catch (error) {
    console.error('Error requesting session report:', error);
    return res.status(500).json({ error: 'Failed to request report: ' + error.message });
  }
}

// DOWNLOAD: Check status and download report
async function handleDownload(req, res) {
  try {
    const { reportId } = req.body;

    if (!reportId) {
      return res.status(400).json({ error: 'Report ID required' });
    }

    const sellingPartner = new SellingPartner({
      region: 'na',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET
      }
    });

    const statusResponse = await sellingPartner.callAPI({
      operation: 'getReport',
      endpoint: 'reports',
      path: {
        reportId
      }
    });

    if (statusResponse.processingStatus !== 'DONE') {
      return res.status(200).json({
        status: statusResponse.processingStatus,
        message: 'Report still processing'
      });
    }

    const documentId = statusResponse.reportDocumentId;
    const documentResponse = await sellingPartner.callAPI({
      operation: 'getReportDocument',
      endpoint: 'reports',
      path: {
        reportDocumentId: documentId
      }
    });

    const downloadResponse = await fetch(documentResponse.url);
    if (!downloadResponse.ok) {
      throw new Error('Failed to download report from URL');
    }
    
    const buffer = Buffer.from(await downloadResponse.arrayBuffer());
    const { gunzipSync } = await import('zlib');
    const decompressed = gunzipSync(buffer);
    const reportDocument = JSON.parse(decompressed.toString());
    
    console.log('Report structure:', JSON.stringify(reportDocument).substring(0, 1000));
    
    let reportData;
    if (typeof reportDocument === 'string') {
      reportData = JSON.parse(reportDocument);
    } else {
      reportData = reportDocument;
    }

    // Extract date from reportSpecification
    const reportDate = reportData.reportSpecification?.dataEndTime?.split('T')[0] || 
                       reportData.reportSpecification?.dataStartTime?.split('T')[0];
    
    const sessionData = parseSessionReport(reportData, reportDate);
    
    // Get existing data and append new data
    const existingData = await kv.get('session_data') || [];
    const combinedData = [...existingData, ...sessionData];
    
    await kv.set('session_data', combinedData);

    return res.status(200).json({
      status: 'DONE',
      success: true,
      recordCount: sessionData.length,
      message: 'Report downloaded and stored successfully'
    });

  } catch (error) {
    console.error('Error downloading session report:', error);
    return res.status(500).json({ error: 'Failed to download report: ' + error.message });
  }
}

// GET: Retrieve stored session data
async function handleGet(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    
    if (!accessToken) {
      return res.status(401).json({ error: 'No access token provided' });
    }

    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    const sessionData = await kv.get('session_data');
    
    if (!sessionData) {
      return res.status(200).json({ 
        success: true,
        data: []
      });
    }

    return res.status(200).json({ 
      success: true,
      data: sessionData
    });

  } catch (error) {
    console.error('Error retrieving session data:', error);
    return res.status(500).json({ error: 'Failed to retrieve session data: ' + error.message });
  }
}

// BACKFILL: Backfill custom date range
async function handleBackfill(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    
    if (!accessToken) {
      return res.status(401).json({ error: 'No access token provided' });
    }

    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start and end dates required (YYYY-MM-DD format)' });
    }

    const sellingPartner = new SellingPartner({
      region: 'na',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET
      }
    });

    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Get existing data
    const existingData = await kv.get('session_data') || [];
    let allData = [...existingData];
    
    let processedDays = 0;
    let currentDate = new Date(start);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split('T')[0];
      
      try {
        res.write(`data: Processing ${dateStr}...\n\n`);
        
        const reportResponse = await sellingPartner.callAPI({
          operation: 'createReport',
          endpoint: 'reports',
          body: {
            reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
            marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
            dataStartTime: `${dateStr}T00:00:00Z`,
            dataEndTime: `${dateStr}T23:59:59Z`,
            reportOptions: {
              asinGranularity: 'CHILD'
            }
          }
        });

        const reportId = reportResponse.reportId;
        
        let attempts = 0;
        let statusResponse;
        
        while (attempts < 24) {
          await sleep(5000);
          
          statusResponse = await sellingPartner.callAPI({
            operation: 'getReport',
            endpoint: 'reports',
            path: { reportId }
          });
          
          if (statusResponse.processingStatus === 'DONE') {
            break;
          }
          
          attempts++;
        }
        
        if (statusResponse.processingStatus !== 'DONE') {
          res.write(`data: Warning: ${dateStr} report timed out, skipping\n\n`);
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }
        
        const documentResponse = await sellingPartner.callAPI({
          operation: 'getReportDocument',
          endpoint: 'reports',
          path: { reportDocumentId: statusResponse.reportDocumentId }
        });
        
        const downloadResponse = await fetch(documentResponse.url);
        const buffer = Buffer.from(await downloadResponse.arrayBuffer());
        const { gunzipSync } = await import('zlib');
        const decompressed = gunzipSync(buffer);
        const reportData = JSON.parse(decompressed.toString());
        
        const dayData = parseSessionReport(reportData, dateStr);
        allData.push(...dayData);
        
        // Save incrementally after each day
        await kv.set('session_data', allData);
        
        processedDays++;
        res.write(`data: Completed ${dateStr} (${processedDays} days processed, ${allData.length} total records)\n\n`);
        
        await sleep(2000);
        
      } catch (error) {
        res.write(`data: Error processing ${dateStr}: ${error.message}\n\n`);
      }
      
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    res.write(`data: COMPLETE - Total ${allData.length} records from ${processedDays} days\n\n`);
    res.end();

  } catch (error) {
    console.error('Backfill error:', error);
    return res.status(500).json({ error: 'Backfill failed: ' + error.message });
  }
}

// SYNC: Daily automated sync (2 days ago)
async function handleSync(req, res) {
  try {
    // Calculate date for 2 days ago
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const dateStr = twoDaysAgo.toISOString().split('T')[0];
    
    console.log(`[SYNC] Starting daily sync for ${dateStr}`);
    
    const sellingPartner = new SellingPartner({
      region: 'na',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET
      }
    });

    // Request report
    console.log(`[SYNC] Requesting report for ${dateStr}`);
    const reportResponse = await sellingPartner.callAPI({
      operation: 'createReport',
      endpoint: 'reports',
      body: {
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
        dataStartTime: `${dateStr}T00:00:00Z`,
        dataEndTime: `${dateStr}T23:59:59Z`,
        reportOptions: {
          asinGranularity: 'CHILD'
        }
      }
    });

    const reportId = reportResponse.reportId;
    console.log(`[SYNC] Report requested, ID: ${reportId}`);
    
    // Poll for completion (max 5 minutes)
    let attempts = 0;
    let statusResponse;
    
    while (attempts < 60) { // 60 * 5 seconds = 5 minutes
      await sleep(5000);
      
      statusResponse = await sellingPartner.callAPI({
        operation: 'getReport',
        endpoint: 'reports',
        path: { reportId }
      });
      
      console.log(`[SYNC] Poll attempt ${attempts + 1}, status: ${statusResponse.processingStatus}`);
      
      if (statusResponse.processingStatus === 'DONE') {
        break;
      }
      
      if (statusResponse.processingStatus === 'FATAL' || statusResponse.processingStatus === 'CANCELLED') {
        throw new Error(`Report failed with status: ${statusResponse.processingStatus}`);
      }
      
      attempts++;
    }
    
    if (statusResponse.processingStatus !== 'DONE') {
      throw new Error('Report timed out after 5 minutes');
    }
    
    console.log(`[SYNC] Report ready, downloading...`);
    
    // Download report
    const documentResponse = await sellingPartner.callAPI({
      operation: 'getReportDocument',
      endpoint: 'reports',
      path: { reportDocumentId: statusResponse.reportDocumentId }
    });
    
    const downloadResponse = await fetch(documentResponse.url);
    if (!downloadResponse.ok) {
      throw new Error('Failed to download report from URL');
    }
    
    const buffer = Buffer.from(await downloadResponse.arrayBuffer());
    const { gunzipSync } = await import('zlib');
    const decompressed = gunzipSync(buffer);
    const reportData = JSON.parse(decompressed.toString());
    
    // Parse data
    const sessionData = parseSessionReport(reportData, dateStr);
    console.log(`[SYNC] Parsed ${sessionData.length} records`);
    
    // Append to existing data
    const existingData = await kv.get('session_data') || [];
    const combinedData = [...existingData, ...sessionData];
    
    await kv.set('session_data', combinedData);
    console.log(`[SYNC] Stored successfully. Total records: ${combinedData.length}`);
    
    return res.status(200).json({
      success: true,
      date: dateStr,
      newRecords: sessionData.length,
      totalRecords: combinedData.length,
      message: `Daily sync complete for ${dateStr}`
    });

  } catch (error) {
    console.error('[SYNC] Error:', error);
    return res.status(500).json({ 
      success: false,
      error: 'Sync failed: ' + error.message 
    });
  }
}

// Helper functions
function parseSessionReport(reportData, date) {
  const data = [];
  const records = reportData.salesAndTrafficByAsin || [];
  
  records.forEach(record => {
    const asin = record.parentAsin;
    const traffic = record.trafficByAsin || {};
    
    data.push({
      date,
      asin,
      sessions: traffic.sessions || 0,
      sessionPercentage: traffic.sessionPercentage || 0,
      pageViews: traffic.pageViews || 0,
      unitSessionPercentage: traffic.unitSessionPercentage || 0,
      buyBoxPercentage: traffic.buyBoxPercentage || 0
    });
  });
  
  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
