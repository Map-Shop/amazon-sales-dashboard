    
    // ============================================
    // BRAND & PRODUCT PROFITABILITY FUNCTIONS
    // ============================================
    
    // Tab switching for Brand & Product page
    function showBPYTD() {
      document.getElementById('bp-ytd-view').style.display = 'block';
      document.getElementById('bp-monthly-view').style.display = 'none';
      document.getElementById('bp-ytd-tab').classList.add('active');
      document.getElementById('bp-monthly-tab').classList.remove('active');
      
      initializeBPYTDDropdowns();
    }
    
    function showBPMonthly() {
      document.getElementById('bp-ytd-view').style.display = 'none';
      document.getElementById('bp-monthly-view').style.display = 'block';
      document.getElementById('bp-ytd-tab').classList.remove('active');
      document.getElementById('bp-monthly-tab').classList.add('active');
      
      initializeBPMonthlyDropdowns();
    }
    
    // Initialize dropdowns for BP YTD
    async function initializeBPYTDDropdowns() {
      // Initialize year dropdown
      const yearSelect = document.getElementById('bp-ytd-year-select');
      if (yearSelect.options.length === 0) {
        const currentYear = new Date().getFullYear();
        for (let year = currentYear; year >= currentYear - 5; year--) {
          const option = document.createElement('option');
          option.value = year;
          option.text = year;
          if (year === currentYear) {
            option.selected = true;
          }
          yearSelect.appendChild(option);
        }
      }
      
      // Initialize brand dropdown
      await initializeBrandDropdown('bp-ytd-brand-select');
    }
    
    // Initialize dropdowns for BP Monthly
    async function initializeBPMonthlyDropdowns() {
      // Initialize year dropdown
      const yearSelect = document.getElementById('bp-monthly-year-select');
      if (yearSelect.options.length === 0) {
        const currentYear = new Date().getFullYear();
        for (let year = currentYear; year >= currentYear - 5; year--) {
          const option = document.createElement('option');
          option.value = year;
          option.text = year;
          if (year === currentYear) {
            option.selected = true;
          }
          yearSelect.appendChild(option);
        }
      }
      
      // Set to last month
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      document.getElementById('bp-monthly-month-select').value = lastMonth.getMonth();
      document.getElementById('bp-monthly-year-select').value = lastMonth.getFullYear();
      
      // Initialize brand dropdown
      await initializeBrandDropdown('bp-monthly-brand-select');
    }
    
    // Initialize brand dropdown from the Upstash products catalog. Same
    // endpoint the v2024 statement / charts pipeline uses — keeps the
    // dropdown in sync with whatever brands actually exist in the catalog
    // (no hardcoded list, no Sheets fetch). Adds an option per distinct
    // non-empty brand, sorted alphabetically.
    async function initializeBrandDropdown(selectId) {
      if (!accessToken) return;

      const select = document.getElementById(selectId);
      if (!select) return;
      if (select.options.length > 1) return; // Already initialized

      try {
        const res = await fetch('/api/products?action=get', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        const products = Array.isArray(data.products) ? data.products : [];
        const brands = new Set();
        for (const p of products) {
          const b = (p?.brand || '').trim();
          if (b) brands.add(b);
        }
        for (const brand of [...brands].sort()) {
          const option = document.createElement('option');
          option.value = brand;
          option.text = brand;
          select.appendChild(option);
        }
      } catch (error) {
        console.error('Error loading brands:', error);
      }
    }
    
    // Quick date setters for BP YTD
    function setBPYTDYear(preset) {
      const yearSelect = document.getElementById('bp-ytd-year-select');
      const currentYear = new Date().getFullYear();
      
      if (preset === 'thisYear') {
        yearSelect.value = currentYear;
      } else if (preset === 'lastYear') {
        yearSelect.value = currentYear - 1;
      }
      
      generateBPYTDReport();
    }
    
    // Quick date setters for BP Monthly
    function setBPMonthlyDate(preset) {
      const monthSelect = document.getElementById('bp-monthly-month-select');
      const yearSelect = document.getElementById('bp-monthly-year-select');
      const now = new Date();
      
      if (preset === 'thisMonth') {
        monthSelect.value = now.getMonth();
        yearSelect.value = now.getFullYear();
      } else if (preset === 'lastMonth') {
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        monthSelect.value = lastMonth.getMonth();
        yearSelect.value = lastMonth.getFullYear();
      }
      
      generateBPMonthlyReport();
    }
    
    // Generate BP YTD Report
    async function generateBPYTDReport() {
      const year = parseInt(document.getElementById('bp-ytd-year-select').value);
      const brandFilter = document.getElementById('bp-ytd-brand-select').value;
      
      if (isNaN(year)) {
        console.error('Invalid year');
        return;
      }
      
      const container = document.getElementById('bp-ytd-content');
      container.innerHTML = '<div style="padding: 4rem; text-align: center;"><div class="spinner"></div><div style="margin-top: 1rem; color: var(--text-secondary); font-size: 0.95rem;">Loading data…</div></div>';
      
      try {
        const today = new Date();
        const currentYear = today.getFullYear();
        const isCurrentYear = year === currentYear;
        
        let startDate = `${year}-01-01`;
        let endDate;
        
        if (isCurrentYear) {
          // End at last complete month
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const lastCompleteMonthYear = today.getMonth() === 0 ? year - 1 : year;
          const endOfLastMonth = new Date(lastCompleteMonthYear, lastCompleteMonth + 1, 0);
          endDate = endOfLastMonth.toISOString().split('T')[0];
        } else {
          endDate = `${year}-12-31`;
        }
        
        // Load brand/product data
        const brandProductData = await loadBrandProductData(startDate, endDate, brandFilter);
        
        // Render the table
        renderBrandProductTable(brandProductData, 'bp-ytd-content');
        
      } catch (error) {
        console.error('Error generating BP YTD report:', error);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${error.message}</div>`;
      }
    }
    
    // Generate BP Monthly Report
    async function generateBPMonthlyReport() {
      const month = parseInt(document.getElementById('bp-monthly-month-select').value);
      const year = parseInt(document.getElementById('bp-monthly-year-select').value);
      const brandFilter = document.getElementById('bp-monthly-brand-select').value;
      
      if (isNaN(month) || isNaN(year)) {
        console.error('Invalid month or year');
        return;
      }
      
      const container = document.getElementById('bp-monthly-content');
      container.innerHTML = '<div style="padding: 4rem; text-align: center;"><div class="spinner"></div><div style="margin-top: 1rem; color: var(--text-secondary); font-size: 0.95rem;">Loading data…</div></div>';
      
      try {
        const startDate = new Date(year, month, 1).toISOString().split('T')[0];
        const endDate = new Date(year, month + 1, 0).toISOString().split('T')[0];
        
        // Load brand/product data
        const brandProductData = await loadBrandProductData(startDate, endDate, brandFilter);
        
        // Render the table
        renderBrandProductTable(brandProductData, 'bp-monthly-content');
        
      } catch (error) {
        console.error('Error generating BP monthly report:', error);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${error.message}</div>`;
      }
    }
    
    // Brand & Product data comes from the server's profitability pipeline
    // (`_loadBrandProductV2024` in overview-upstash.js asks for it;
    // lib/profitability.js handles dedup, ad-spend allocation, shipping,
    // etc.). Wrapped in this thin shim
    // so `generateBPYTDReport` / `generateBPMonthlyReport` keep their
    // existing call sites.
    async function loadBrandProductData(startDate, endDate, brandFilter) {
      return window._loadBrandProductV2024(startDate, endDate, brandFilter);
    }

    // Render the brand/product table
    function renderBrandProductTable(brandData, containerId) {
      const container = document.getElementById(containerId);
      
      if (!brandData || brandData.length === 0) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">No data available for this period</div>';
        return;
      }
      
      // Column order: Total | FBM | FBA. Total is left-most so the
      // most-important grouping is read first when scanning the table
      // and (combined with the sticky first-column "Brand / Product"
      // name) it sits right next to the row label.
      //
      // Each brand + its products go into their own <tbody> element so
      // sticky positioning on the brand row can pin within that group.
      // When you scroll past a brand's last product, its <tbody> ends
      // and the next brand's row takes over the pinned slot.
      let html = `
        <div class="bp-table-wrapper">
          <table class="bp-table">
            <thead>
              <tr>
                <th rowspan="2">Brand / Product</th>
                <th colspan="6" class="header-group total">Total</th>
                <th colspan="6" class="header-group fbm">FBM</th>
                <th colspan="6" class="header-group fba">FBA</th>
              </tr>
              <tr>
                <th>Income</th>
                <th>OpEx</th>
                <th>Costs</th>
                <th>Ads</th>
                <th>Profit</th>
                <th>Margin</th>
                <th>Income</th>
                <th>OpEx</th>
                <th>Costs</th>
                <th>Ads</th>
                <th>Profit</th>
                <th>Margin</th>
                <th>Income</th>
                <th>OpEx</th>
                <th>Costs</th>
                <th>Ads</th>
                <th>Profit</th>
                <th>Margin</th>
              </tr>
            </thead>
      `;

      brandData.forEach(brand => {
        const brandId = brand.brandName.replace(/\s+/g, '-');
        html += `<tbody class="brand-group" data-brand="${brandId}">`;
        // Brand row
        html += `
          <tr class="brand-row" onclick="toggleBrand('${brandId}')">
            <td>
              <div class="brand-name">
                <span class="expand-icon">▶</span>
                <strong>${brand.brandName}</strong>
              </div>
            </td>
            ${renderMetricsCells(brand.total)}
            ${renderMetricsCells(brand.fbm)}
            ${renderMetricsCells(brand.fba)}
          </tr>
        `;

        // Product rows (initially hidden)
        brand.products.forEach(product => {
          html += `
            <tr class="product-row" data-brand="${brandId}" style="display: none;">
              <td>${product.productName}</td>
              ${renderMetricsCells(product.total)}
              ${renderMetricsCells(product.fbm, product.skus.some(s => s.fulfillmentType === 'FBM'))}
              ${renderMetricsCells(product.fba, product.skus.some(s => s.fulfillmentType === 'FBA'))}
            </tr>
          `;
        });
        html += `</tbody>`;
      });

      html += `
          </table>
        </div>
      `;

      container.innerHTML = html;

      // Measure the actual rendered thead height and expose it as a CSS
      // variable so sticky brand rows pin exactly below the headers
      // regardless of font / padding tweaks. requestAnimationFrame waits
      // one frame so layout is settled before we read measurements.
      requestAnimationFrame(() => {
        const table = container.querySelector('.bp-table');
        const thead = table?.querySelector('thead');
        if (table && thead) {
          const h = Math.ceil(thead.getBoundingClientRect().height);
          if (h > 0) table.style.setProperty('--bp-thead-height', `${h}px`);
        }
      });
    }
    
    // Helper to render metrics cells
    function renderMetricsCells(metrics, hasData = true) {
      if (!hasData) {
        return '<td class="neutral">--</td><td class="neutral">--</td><td class="neutral">--</td><td class="neutral">--</td><td class="neutral">--</td><td class="neutral">--</td>';
      }
      
      // Thousands separators via toLocaleString — e.g. 1234567.8 →
      // "1,234,567.80". minimumFractionDigits/maximumFractionDigits = 2
      // keeps cents aligned even on whole-dollar values. Negatives use
      // a leading minus sign rather than parentheses to match the rest
      // of the table's number style.
      const formatMoney = (val) => {
        const abs = Math.abs(val).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
        if (val === 0) return '$0.00';
        return val >= 0 ? `$${abs}` : `-$${abs}`;
      };
      
      const profitClass = metrics.profit >= 0 ? 'positive' : 'negative';
      const marginClass = metrics.margin >= 0 ? 'positive' : 'negative';
      
      return `
        <td>${formatMoney(metrics.income)}</td>
        <td>${formatMoney(metrics.opex)}</td>
        <td>${formatMoney(metrics.productCosts)}</td>
        <td>${formatMoney(metrics.adSpend)}</td>
        <td class="${profitClass}">${formatMoney(metrics.profit)}</td>
        <td class="${marginClass}">${metrics.margin.toFixed(1)}%</td>
      `;
    }
    
    // Toggle brand expansion
    function toggleBrand(brandId) {
      const brandRow = event.currentTarget;
      const isExpanded = brandRow.classList.contains('expanded');
      const productRows = document.querySelectorAll(`tr.product-row[data-brand="${brandId}"]`);
      
      if (isExpanded) {
        brandRow.classList.remove('expanded');
        productRows.forEach(row => row.style.display = 'none');
      } else {
        brandRow.classList.add('expanded');
        productRows.forEach(row => row.style.display = 'table-row');
      }
    }
    
    
    
    
    // Format comparison percentage with color indicator
    function formatComparison(value, inverted = false) {
      if (value === null || value === undefined) return 'N/A';
      
      const isPositive = value >= 0;
      // For income/profit: green when up, red when down
      // For expenses: red when up, green when down (inverted)
      const isGood = inverted ? !isPositive : isPositive;
      const color = isGood ? 'var(--success)' : 'var(--error)';
      const arrow = isPositive ? '↑' : '↓';
      
      return `<span style="color: ${color};">${arrow} ${Math.abs(value).toFixed(1)}%</span>`;
    }
    
    function renderFinancialStatement(statement, startDate, endDate, container, comparisons = null) {
      
      // Calculate FBM totals
      const fbmIncome = (statement.income['FBM Sales']?.credit || 0) - (statement.income['FBM Sales']?.debit || 0) +
                        (statement.income['FBM Returns']?.credit || 0) - (statement.income['FBM Returns']?.debit || 0) +
                        (statement.income['FBM Other']?.credit || 0) - (statement.income['FBM Other']?.debit || 0);
      
      const fbmExpensesExcludingCostAndAd = 
        (statement.expenses['FBM Shipping Costs']?.debit || 0) - (statement.expenses['FBM Shipping Costs']?.credit || 0) +
        (statement.expenses['FBM Transaction Fees']?.debit || 0) - (statement.expenses['FBM Transaction Fees']?.credit || 0);
      
      const fbmProductCosts = (statement.expenses['FBM Product Costs']?.debit || 0) - (statement.expenses['FBM Product Costs']?.credit || 0);
      const fbmAdSpend = statement.expenses['FBM Ad Spend']?.debit || 0;
      const fbmProfit = fbmIncome - fbmExpensesExcludingCostAndAd - fbmProductCosts - fbmAdSpend;
      const fbmMargin = fbmIncome > 0 ? (fbmProfit / fbmIncome * 100) : 0;
      
      // Calculate FBA totals
      const fbaIncome = (statement.income['FBA Sales']?.credit || 0) - (statement.income['FBA Sales']?.debit || 0) +
                        (statement.income['FBA Returns']?.credit || 0) - (statement.income['FBA Returns']?.debit || 0) +
                        (statement.income['FBA Other']?.credit || 0) - (statement.income['FBA Other']?.debit || 0);
      
      const fbaExpensesExcludingCostAndAd = 
        (statement.expenses['FBA Transaction Fees']?.debit || 0) - (statement.expenses['FBA Transaction Fees']?.credit || 0) +
        (statement.expenses['FBA Fees']?.debit || 0) - (statement.expenses['FBA Fees']?.credit || 0) +
        (statement.expenses['FBA Inbound Placement Fees']?.debit || 0) - (statement.expenses['FBA Inbound Placement Fees']?.credit || 0) +
        (statement.expenses['FBA Inbound Shipping Costs']?.debit || 0) - (statement.expenses['FBA Inbound Shipping Costs']?.credit || 0) +
        (statement.expenses['FBA Inventory Storage Fees']?.debit || 0) - (statement.expenses['FBA Inventory Storage Fees']?.credit || 0) +
        (statement.expenses['FBA Inventory Adjustment']?.debit || 0) - (statement.expenses['FBA Inventory Adjustment']?.credit || 0);
      
      const fbaProductCosts = (statement.expenses['FBA Product Costs']?.debit || 0) - (statement.expenses['FBA Product Costs']?.credit || 0);
      const fbaAdSpend = statement.expenses['FBA Ad Spend']?.debit || 0;
      const fbaProfit = fbaIncome - fbaExpensesExcludingCostAndAd - fbaProductCosts - fbaAdSpend;
      const fbaMargin = fbaIncome > 0 ? (fbaProfit / fbaIncome * 100) : 0;
      
      // Calculate combined totals
      const otherExpenses = (statement.expenses['Other Expenses']?.debit || 0) - (statement.expenses['Other Expenses']?.credit || 0);
      const unallocatedAdSpend = statement.expenses['Unallocated Ad Spend']?.debit || 0;
      
      const totalIncome = fbmIncome + fbaIncome;
      const totalExpensesExcludingCostAndAd = fbmExpensesExcludingCostAndAd + fbaExpensesExcludingCostAndAd + otherExpenses;
      const totalProductCosts = fbmProductCosts + fbaProductCosts;
      const totalAdSpend = fbmAdSpend + fbaAdSpend + unallocatedAdSpend;
      const totalProfit = totalIncome - totalExpensesExcludingCostAndAd - totalProductCosts - totalAdSpend;
      const totalMargin = totalIncome > 0 ? (totalProfit / totalIncome * 100) : 0;
      
      // Calculate overall totals for traditional view
      let incomeTotalDebit = 0, incomeTotalCredit = 0;
      Object.values(statement.income).forEach(item => {
        incomeTotalDebit += item.debit;
        incomeTotalCredit += item.credit;
      });
      
      let expenseTotalDebit = 0, expenseTotalCredit = 0;
      Object.values(statement.expenses).forEach(item => {
        expenseTotalDebit += item.debit;
        expenseTotalCredit += item.credit;
      });
      
      let html = `
        <div style="margin-bottom: 2rem;">
          <div style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
            Report Period: ${startDate} - ${endDate}
          </div>
        </div>
        
        <div style="display: flex; flex-wrap: wrap; gap: 2rem; align-items: flex-start;">
          <!-- LEFT SIDE: Traditional Statement -->
          <div>
            <!-- Income Section -->
            <div style="margin-bottom: 2rem;">
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: var(--success);">Income</h3>
              <table>
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); width: 50%;">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Debit</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Credit</th>
                  </tr>
                </thead>
                <tbody>
      `;
      
      Object.entries(statement.income).forEach(([category, amounts]) => {
        html += `
          <tr>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">${category}</td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">
              ${amounts.debit > 0 ? '$' + formatNumber(amounts.debit) : '$0.00'}
            </td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">
              ${amounts.credit > 0 ? '$' + formatNumber(amounts.credit) : '$0.00'}
            </td>
          </tr>
        `;
      });
      
      html += `
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Totals</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">$${formatNumber(incomeTotalDebit)}</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">$${formatNumber(incomeTotalCredit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            
            <!-- Expenses Section -->
            <div>
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: var(--error);">Expenses</h3>
              <table>
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); width: 50%;">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Debit</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Credit</th>
                  </tr>
                </thead>
                <tbody>
      `;
      
      Object.entries(statement.expenses).forEach(([category, amounts]) => {
        html += `
          <tr>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">${category}</td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">
              ${amounts.debit > 0 ? '$' + formatNumber(amounts.debit) : '$0.00'}
            </td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">
              ${amounts.credit > 0 ? '$' + formatNumber(amounts.credit) : '$0.00'}
            </td>
          </tr>
        `;
      });
      
      html += `
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Totals</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">$${formatNumber(expenseTotalDebit)}</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">$${formatNumber(expenseTotalCredit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          
          <!-- RIGHT SIDE: Profitability Analysis -->
          <div style="display: flex; flex-direction: column; gap: 1.5rem;">
            <!-- FBM Profitability -->
            <div style="margin-bottom: 2rem;">
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">FBM Profitability</h3>
              <table>
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 46%;' : 'width: 50%;') : 'width: 50%;'}">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 27%;' : 'width: 35%;') : 'width: 50%;'} min-width: 140px;">Total</th>
                    ${comparisons ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ' + (comparisons.fbm.income.mom !== undefined ? 'width: 13.5%;' : 'width: 15%;') + ' min-width: 80px;">YoY</th>' : ''}
                    ${comparisons && comparisons.fbm.income.mom !== undefined ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 13.5%; min-width: 80px;">MoM</th>' : ''}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Income</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${fbmIncome >= 0 ? '$' + formatNumber(fbmIncome) : '-$' + formatNumber(Math.abs(fbmIncome))}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.income.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fbm.income.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.income.mom, false)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Operating Expenses</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbmExpensesExcludingCostAndAd)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.opex.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fbm.opex.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.opex.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Product Costs</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbmProductCosts)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.productCosts.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fbm.productCosts.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.productCosts.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Ad Spend</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbmAdSpend)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.adSpend.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fbm.adSpend.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.adSpend.mom, true)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Profit</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; color: ${fbmProfit >= 0 ? 'var(--success)' : 'var(--error)'};">${fbmProfit >= 0 ? '$' : '-$'}${formatNumber(Math.abs(fbmProfit))}</td>
                    ${comparisons ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.profit.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fbm.profit.mom !== undefined ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.profit.mom, false)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Margin</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace; color: ${fbmMargin >= 0 ? 'var(--success)' : 'var(--error)'};">${fbmMargin.toFixed(1)}%</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.margin.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fbm.margin.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.margin.mom, false)}</td>` : ''}
                  </tr>
                </tbody>
              </table>
            </div>
            
            <!-- FBA Profitability -->
            <div style="margin-bottom: 2rem;">
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">FBA Profitability</h3>
              <table>
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 46%;' : 'width: 50%;') : 'width: 50%;'}">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 27%;' : 'width: 35%;') : 'width: 50%;'} min-width: 140px;">Total</th>
                    ${comparisons ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ' + (comparisons.fbm.income.mom !== undefined ? 'width: 13.5%;' : 'width: 15%;') + ' min-width: 80px;">YoY</th>' : ''}
                    ${comparisons && comparisons.fbm.income.mom !== undefined ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 13.5%; min-width: 80px;">MoM</th>' : ''}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Income</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${fbaIncome >= 0 ? '$' + formatNumber(fbaIncome) : '-$' + formatNumber(Math.abs(fbaIncome))}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.income.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fba.income.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.income.mom, false)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Operating Expenses</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbaExpensesExcludingCostAndAd)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.opex.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fba.opex.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.opex.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Product Costs</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbaProductCosts)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.productCosts.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fba.productCosts.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.productCosts.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Ad Spend</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbaAdSpend)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.adSpend.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fba.adSpend.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.adSpend.mom, true)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Profit</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; color: ${fbaProfit >= 0 ? 'var(--success)' : 'var(--error)'};">${fbaProfit >= 0 ? '$' : '-$'}${formatNumber(Math.abs(fbaProfit))}</td>
                    ${comparisons ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.profit.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fba.profit.mom !== undefined ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.profit.mom, false)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Margin</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace; color: ${fbaMargin >= 0 ? 'var(--success)' : 'var(--error)'};">${fbaMargin.toFixed(1)}%</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.margin.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fba.margin.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.margin.mom, false)}</td>` : ''}
                  </tr>
                </tbody>
              </table>
            </div>
            
            <!-- Total Profitability -->
            <div>
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">Total Profitability</h3>
              <table>
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 46%;' : 'width: 50%;') : 'width: 50%;'}">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 27%;' : 'width: 35%;') : 'width: 50%;'} min-width: 140px;">Total</th>
                    ${comparisons ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ' + (comparisons.fbm.income.mom !== undefined ? 'width: 13.5%;' : 'width: 15%;') + ' min-width: 80px;">YoY</th>' : ''}
                    ${comparisons && comparisons.fbm.income.mom !== undefined ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 13.5%; min-width: 80px;">MoM</th>' : ''}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Income</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${totalIncome >= 0 ? '$' + formatNumber(totalIncome) : '-$' + formatNumber(Math.abs(totalIncome))}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.income.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.total.income.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.income.mom, false)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Operating Expenses</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(totalExpensesExcludingCostAndAd)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.opex.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.total.opex.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.opex.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Product Costs</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(totalProductCosts)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.productCosts.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.total.productCosts.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.productCosts.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Ad Spend</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(totalAdSpend)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.adSpend.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.total.adSpend.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.adSpend.mom, true)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Profit</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; color: ${totalProfit >= 0 ? 'var(--success)' : 'var(--error)'};">${totalProfit >= 0 ? '$' : '-$'}${formatNumber(Math.abs(totalProfit))}</td>
                    ${comparisons ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.profit.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.total.profit.mom !== undefined ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.profit.mom, false)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Margin</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace; color: ${totalMargin >= 0 ? 'var(--success)' : 'var(--error)'};">${totalMargin.toFixed(1)}%</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.margin.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.total.margin.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.margin.mom, false)}</td>` : ''}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;
      
      container.innerHTML = html;
    }
