// repro/repro-progress.js：工具→播报短语映射（spec §6.4 表）
function progressPhrase(name) {
  const map = { bash: '正在执行命令', read: '正在查找文件', grep: '正在查找文件', glob: '正在查找文件',
    write: '正在修改文件', edit: '正在修改文件', web_search: '正在搜索网页',
    guide_dog_image: '正在生成媒体', guide_dog_video: '正在生成媒体', guide_dog_music: '正在生成媒体', guide_dog_speak: '正在生成媒体',
    skill: '正在调用技能' }
  return map[name] || '正在执行操作'
}
console.assert(progressPhrase('bash') === '正在执行命令', 'FAIL: bash')
console.assert(progressPhrase('unknown_tool') === '正在执行操作', 'FAIL: fallback')
console.log('PASS: progress phrase mapping')
