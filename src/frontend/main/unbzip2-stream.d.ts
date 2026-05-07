declare module 'unbzip2-stream' {
  import { Transform } from 'stream';
  export default function unbzip2(): Transform;
}
