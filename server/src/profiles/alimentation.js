// Profil « alimentation » : ce qui est propre à ce type de magasin.
// Les autres types (vêtements, électronique…) auront leur propre profil.
export const alimentation = {
  id: 'alimentation',
  defaultShopName: 'Mon Magasin',
  units: ['piece', 'kg', 'litre'], // vente à la pièce ou au poids/volume
  tracksExpiry: true, // dates de péremption
  categories: [
    { fr: 'Épicerie', ar: 'بقالة', icon: '🥫' },
    { fr: 'Boissons', ar: 'مشروبات', icon: '🥤' },
    { fr: 'Produits laitiers', ar: 'منتجات الألبان', icon: '🥛' },
    { fr: 'Fruits et légumes', ar: 'فواكه وخضروات', icon: '🥬' },
    { fr: 'Viandes et poissons', ar: 'لحوم وأسماك', icon: '🍖' },
    { fr: 'Boulangerie', ar: 'مخبوزات', icon: '🥖' },
    { fr: 'Riz, farine, sucre', ar: 'أرز ودقيق وسكر', icon: '🍚' },
    { fr: 'Huiles et condiments', ar: 'زيوت وتوابل', icon: '🧂' },
    { fr: 'Hygiène et entretien', ar: 'نظافة وصيانة', icon: '🧼' },
    { fr: 'Autres', ar: 'أخرى', icon: '🛒' },
  ],
};
