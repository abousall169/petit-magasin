import { useState } from 'react';
import { useApp } from '../ctx.js';
import SubTabs from '../components/SubTabs.jsx';
import Products from './Products.jsx';
import Purchases from './Purchases.jsx';
import Suppliers from './Suppliers.jsx';
import Categories from './Categories.jsx';

export default function Stock() {
  const { t } = useApp();
  const [tab, setTab] = useState('products');
  return (
    <div className="flex h-full flex-col">
      <SubTabs value={tab} onChange={setTab} tabs={[['products', t.products], ['purchases', t.purchases], ['suppliers', t.suppliers], ['categories', t.categories]]} />
      <div className="min-h-0 flex-1">
        {tab === 'products' && <Products />}
        {tab === 'purchases' && <Purchases />}
        {tab === 'suppliers' && <Suppliers />}
        {tab === 'categories' && <Categories />}
      </div>
    </div>
  );
}
