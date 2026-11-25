import { useEffect, useMemo, useState } from 'react';
import { request } from './lib';

type Restaurant = { id: string; name: string; slug: string; timezone?: string; currency?: string; createdAt?: string };

export function PlatformAdminPanel({ onSelect }: { onSelect: (restaurant: Restaurant) => void }) {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    request<Restaurant[]>('/auth/platform/tenants')
      .then(setRestaurants)
      .catch((cause) => setError((cause as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es');
    return restaurants.filter((restaurant) => `${restaurant.name} ${restaurant.slug}`.toLocaleLowerCase('es').includes(term));
  }, [restaurants, search]);

  return <main className="platform-admin-page">
    <header className="platform-admin-header">
      <div className="brand-mark">B</div>
      <div><p className="eyebrow">ADMINISTRACIÓN GLOBAL</p><h1>Restaurantes</h1><p>Elige un local para abrir su panel de gestión.</p></div>
    </header>
    <section className="platform-admin-content">
      <div className="section-head"><div><h3>Locales registrados</h3><p>{restaurants.length} {restaurants.length === 1 ? 'restaurante' : 'restaurantes'}</p></div><span className="pill">Solo administradores</span></div>
      <label className="platform-search">Buscar restaurante<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nombre o identificador"/></label>
      {error && <p className="error">{error}</p>}
      {loading ? <p className="platform-empty">Cargando restaurantes…</p> : visible.length ? <div className="platform-restaurant-grid">{visible.map((restaurant) => <button className="platform-restaurant-card" key={restaurant.id} onClick={() => onSelect(restaurant)}>
        <span className="platform-restaurant-icon">⌂</span><span className="platform-restaurant-copy"><strong>{restaurant.name}</strong><small>{restaurant.slug}</small></span><span className="platform-restaurant-arrow">→</span>
      </button>)}</div> : <p className="platform-empty">{restaurants.length ? 'No hay coincidencias.' : 'No hay restaurantes activos todavía.'}</p>}
    </section>
  </main>;
}
