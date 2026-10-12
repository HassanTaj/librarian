import { connection } from 'next/server';
import { AccessNotice } from '../components/access-notice';

export async function generateMetadata() {
  await connection();
  return { title: 'Synthetic coverage proof' };
}

export default async function Page() {
  await connection();
  return <main><h1>Synthetic coverage proof</h1><AccessNotice /></main>;
}
