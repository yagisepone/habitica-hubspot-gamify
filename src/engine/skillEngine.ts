export function getLearningModuleByLevel(level: number): string {
  if (level < 5) return '基本営業トーク講座';
  if (level < 10) return 'クロージング強化セミナー';
  return 'マネジメント研修プログラム';
}
