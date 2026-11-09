import { useState } from 'react';
import { useApp } from '../ctx.js';
import SubTabs from '../components/SubTabs.jsx';
import Report from './Report.jsx';
import Cash from './Cash.jsx';
import Expenses from './Expenses.jsx';

export default function Manage() {
  const { t } = useApp();
  const [tab, setTab] = useState('report');
  return (
    <div className="flex h-full flex-col">
      <SubTabs value={tab} onChange={setTab} tabs={[['report', t.report], ['cash', t.cashRegister], ['expenses', t.expenses]]} />
      <div className="min-h-0 flex-1">
        {tab === 'report' && <Report />}
        {tab === 'cash' && <Cash />}
        {tab === 'expenses' && <Expenses />}
      </div>
    </div>
  );
}
