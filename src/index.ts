import type { ProviderDefinition } from '@vault-flow/provider-api';
import { InstagramSavedProvider } from './provider';

const createInstagramSavedProvider: ProviderDefinition = () => new InstagramSavedProvider();

export default createInstagramSavedProvider;
